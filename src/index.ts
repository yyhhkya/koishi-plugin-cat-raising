/**
 * @name cat-raising
 * @description 一个用于监控QQ群内B站直播间奖励信息，并自动转发到指定目标的Koishi插件。
 * 它能智能解析非结构化的文本，提取关键信息（直播间号、时间、奖励），并进行去重和信息补全。
 * @version 2.1.0
 * @author YourName
 */

import { Context, Schema } from 'koishi'

export const name = 'cat-raising'

// --- 配置 Schema ---

// 【改动 1】为 monitorGroups 的对象元素定义一个接口，增强类型安全和可读性
export interface MonitorGroupConfig {
  groupId: string
  sendHelperMessages: boolean
}

export interface Config {
  targetQQ: string
  isGroup: boolean
  // 【改动 2】将 monitorGroups 的类型从 string[] 改为 MonitorGroupConfig[]
  monitorGroups: MonitorGroupConfig[]
  historySize: number
}

export const Config: Schema<Config> = Schema.object({
  targetQQ: Schema.string().description('目标QQ号或QQ群号').required(),
  isGroup: Schema.boolean().description('是否为QQ群').default(false),
  // 【改动 3】修改 Schema 定义，使其成为一个对象数组
  monitorGroups: Schema.array(Schema.object({
    groupId: Schema.string().description('要监听的 QQ 群号').required(),
    sendHelperMessages: Schema.boolean().description('是否在此群内发送“看到啦”之类的辅助/警告消息').default(true),
  }))
    .description('监听的群组列表及其配置')
    .required(),
  historySize: Schema.number()
    .description('用于防复读的历史记录大小，防止短期内对同一活动重复转发')
    .default(30)
    .min(5)
    .max(100),
})

// --- 消息解析模块 (无变动) ---

/**
 * 智能转换文本中的中文数字为阿拉伯数字。
 * @param text 包含中文数字的原始文本。
 * @returns 转换后的文本。
 */
function preprocessChineseNumerals(text: string): string {
  const numMap = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
  const unitMap = {
    '十': { value: 10, isSection: false },
    '百': { value: 100, isSection: false },
    '千': { value: 1000, isSection: false },
    '万': { value: 10000, isSection: true },
    '亿': { value: 100000000, isSection: true },
  }

  const chineseNumRegex = /([一二三四五六七八九十百千万亿两零]+)/g
  return text.replace(chineseNumRegex, (match) => {
    if (match.length === 1 && !numMap[match] && !unitMap[match]) return match

    let total = 0
    let sectionTotal = 0
    let currentNum = 0

    for (const char of match) {
      if (numMap[char] !== undefined) {
        currentNum = numMap[char]
      } else if (unitMap[char]) {
        const { value, isSection } = unitMap[char]
        if (value === 10 && currentNum === 0) currentNum = 1
        sectionTotal += currentNum * value
        currentNum = 0
        if (isSection) {
          total += sectionTotal
          sectionTotal = 0
        }
      }
    }
    total += sectionTotal + currentNum
    return String(total)
  })
}

interface Reward { amount: number; condition: string }
interface ParsedEvent { dateTime: string; rewards: Reward[] }

/**
 * 从文本中提取所有可能是B站直播间的ID，并进行净化处理。
 * @param text 待查找的文本，可能包含CQ码。
 * @returns 一个包含所有不重复房间ID的字符串数组。
 */
function extractAllRoomIds(text: string): string[] {
  // 在匹配前先移除所有CQ码/HTML标签，防止其属性值（如 file-size）被误识别为房间号
  const sanitizedText = text.replace(/<[^>]+>/g, '')

  const patterns = [
    /(?:播间号|房间号|直播间)[:：\s]*(\d{6,15})/g,
    /\b(\d{6,15})\b/g, // 使用单词边界确保匹配的是独立数字
  ]
  const foundIds = new Set<string>()
  for (const pattern of patterns) {
    for (const match of sanitizedText.matchAll(pattern)) {
      if (match[1]) foundIds.add(match[1])
    }
  }
  return Array.from(foundIds)
}

/**
 * 从单行文本中寻找并格式化时间日期信息。
 * @param line 待解析的单行文本。
 * @returns 格式化后的时间字符串，或 null。
 */
function extractDateTime(line: string): string | null {
  let match: RegExpMatchArray
  if ((match = line.match(/(\d{1,2})\s*[月.]\s*(\d{1,2})\s*日?/))) return `${match[1]}月${match[2]}日`
  if ((match = line.match(/每晚\s*(\d{1,2})\s*[点时]/))) return `每晚 ${match[1].padStart(2, '0')}:00`
  if ((match = line.match(/(\d{1,2}\s*月\s*(?:上|中|下)旬)/))) return match[1]
  if ((match = line.match(/(\d{1,2})[:：.点时]\s*(\d{1,2})/))) return `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`
  if ((match = line.match(/(\d{1,2})\s*点\s*半/))) return `${match[1].padStart(2, '0')}:30`
  if ((match = line.match(/\b(\d{1,2})\s*[.点时](?!\d)/))) return `${match[1].padStart(2, '0')}:00`
  if ((match = line.match(/(\d{1,2})\s*分/))) {
    const now = new Date()
    const minuteVal = parseInt(match[1])
    const hourVal = now.getMinutes() > minuteVal ? now.getHours() + 1 : now.getHours()
    return `${(hourVal % 24).toString().padStart(2, '0')}:${match[1].padStart(2, '0')}`
  }
  if ((match = line.match(/.*?(?:生日|周年|新衣|活动).*/))) return match[0].trim()
  return null
}

/**
 * 从单行文本中解析奖励信息。
 * @param line 待解析的单行文本。
 * @returns 包含奖励信息的对象数组。
 */
function extractRewards(line: string): Reward[] {
  const rewards: Reward[] = []
  const regex = /(?:(\d{1,2})\s*级(?:灯牌)?\s*)?(?:发\s*)?(\d+\.?\d*w\+?|\b\d{3,5}\b)(?:神金|钻石|猫猫钻)?/gi
  let match: RegExpExecArray
  while ((match = regex.exec(line)) !== null) {
    const condition = match[1] ? `${match[1]}级灯牌` : '无限制'
    const amountStr = (match[2] || '').toLowerCase()
    const amount = amountStr.includes('w') ? parseFloat(amountStr.replace('w', '')) * 10000 : parseFloat(amountStr)
    if (!isNaN(amount) && amount > 0) {
      rewards.push({ amount, condition })
    }
  }
  return rewards
}

/**
 * 整合解析流程，将完整消息文本转换为结构化的事件数据。
 * @param text 完整的消息内容。
 * @returns 包含解析后事件的对象，若无有效信息则返回 null。
 */
function parseEventFromText(text: string): ParsedEvent | null {
  const lines = text.split('\n').filter(line => line.trim())
  let globalDateTime: string | null = null
  for (const line of lines) {
    const timeInLine = extractDateTime(line)
    if (timeInLine) {
      globalDateTime = timeInLine
      break
    }
  }
  const allRewards = lines.flatMap(line => extractRewards(line))
  return allRewards.length > 0 ? { dateTime: globalDateTime || '时间未知', rewards: allRewards } : null
}

// --- 插件主逻辑 ---

interface ForwardedEntry {
  originalMessageId: string
  forwardedMessageId: string
  helperMessageId?: string
  roomId: string
  dateTime: string
}

interface BiliInfo {
  videoCount: number
}

// 过滤关键词常量
const HARD_REJECTION_KEYWORDS = ['发言榜单']
const REJECTION_KEYWORDS = ['签到', '打卡']
const OVERRIDE_KEYWORDS = ['神金', '发']
const TRIGGER_REGEX = /神金|发|掉落|猫猫钻|w|\b\d{3,5}\b|一千|一百|十|九|八|七|六|五|四|三|两|二|一/i

/**
 * 异步获取B站直播间关联的用户信息。
 * @param ctx Koishi 上下文。
 * @param roomId 直播间ID。
 * @returns 包含用户信息的对象，失败则返回 null。
 */
async function fetchBilibiliInfo(ctx: Context, roomId: string): Promise<BiliInfo | null> {
  try {
    const roomInfo = await ctx.http.get(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`)
    const uid = roomInfo?.data?.uid
    if (!uid) throw new Error('无法从房间信息中获取UID')

    const statsInfo = await ctx.http.get(`https://api.bilibili.com/x/space/navnum?mid=${uid}`)
    const videoCount = statsInfo?.data?.video
    if (videoCount === undefined) throw new Error('无法从空间信息中获取投稿数')

    return { videoCount }
  } catch (error) {
    ctx.logger.warn(`[API] 获取直播间 ${roomId} 的B站信息失败: ${error.message}`)
    return null
  }
}

export function apply(ctx: Context, config: Config) {
  const forwardedHistory: ForwardedEntry[] = []
  const warningMessageMap = new Map<string, string>()

  ctx.on('message', async (session) => {
    // --- 1. 初步过滤 (Guards) ---
    // 【改动 4】修改监听群组的判断逻辑
    const groupConfig = config.monitorGroups.find(g => g.groupId === session.channelId)
    if (!groupConfig) return

    const strippedContent = session.stripped.content
    if (!strippedContent.trim()) return // 忽略纯图片、表情等无文本消息

    if (HARD_REJECTION_KEYWORDS.some(keyword => strippedContent.includes(keyword))) return
    if (!TRIGGER_REGEX.test(strippedContent)) return

    // --- 2. 核心信息提取与验证 ---
    const roomIds = extractAllRoomIds(session.content)
    if (roomIds.length !== 1) {
      if (roomIds.length > 1) ctx.logger.info(`[忽略] 消息包含多个房间号: ${roomIds.join(', ')}`)
      return
    }
    const roomId = roomIds[0]

    const preprocessedMessage = preprocessChineseNumerals(strippedContent)
    const hasRejectionKeyword = REJECTION_KEYWORDS.some(keyword => preprocessedMessage.includes(keyword))
    if (hasRejectionKeyword && !OVERRIDE_KEYWORDS.some(keyword => preprocessedMessage.includes(keyword))) return

    const parsedEvent = parseEventFromText(preprocessedMessage)
    if (!parsedEvent) return

    const hasStrongContext = /神金|发|w/i.test(preprocessedMessage)
    const hasTime = parsedEvent.dateTime !== '时间未知'
    if (!hasStrongContext && !hasTime) return

    // --- 3. 防复读检查 ---
    const { dateTime } = parsedEvent
    if (forwardedHistory.some(entry => entry.roomId === roomId && entry.dateTime === dateTime)) {
      ctx.logger.info(`[防复读] 检测到重复活动: 房间=${roomId}, 时间=${dateTime}`)
      // 【改动 5】根据群组配置决定是否发送警告消息
      if (groupConfig.sendHelperMessages) {
        try {
          const [warningId] = await session.send(`看到啦看到啦，不要发那么多次嘛~`)
          if (warningId) warningMessageMap.set(session.messageId, warningId)
        } catch (e) {
          ctx.logger.warn('[消息] 发送重复警告失败:', e)
        }
      }
      return
    }

    // --- 4. 获取外部信息 ---
    const biliInfo = await fetchBilibiliInfo(ctx, roomId)
    if (!biliInfo) {
      // await session.send(`[猫猫] 获取直播间 ${roomId} 的信息失败了喵...`)
      return
    }

    // 【改动 6】根据群组配置决定是否发送B站信息，并处理 helperMessageId 可能不存在的情况
    let helperMessageId: string | undefined
    if (groupConfig.sendHelperMessages) {
      [helperMessageId] = await session.send(`直播间: ${roomId}\n投稿数: ${biliInfo.videoCount}`)
    }

    // --- 5. 转发并记录 ---
    try {
      const forwardMessage = `${session.content}\n\n---\n投稿数: ${biliInfo.videoCount}`
      const [forwardedMessageId] = config.isGroup
        ? await session.bot.sendMessage(config.targetQQ, forwardMessage)
        : await session.bot.sendPrivateMessage(config.targetQQ, forwardMessage)

      forwardedHistory.push({
        originalMessageId: session.messageId,
        forwardedMessageId,
        helperMessageId, // helperMessageId 可能是 undefined，这没有问题
        roomId,
        dateTime,
      })
      if (forwardedHistory.length > config.historySize) forwardedHistory.shift()
    } catch (error) {
      session.send('🐱 - 转发失败，请检查目标QQ/群号配置是否正确')
      ctx.logger.error('[转发] 失败:', error)
    }
  })

  // --- `message-deleted` 处理器 (无变动，因为已有安全检查) ---
  // 原有的 if (entry.helperMessageId) 和 warningMessageMap.has() 检查
  // 能完美处理 helperMessageId 和 warningMessageId 不存在的情况。
  ctx.on('message-deleted', async (session) => {
    // 【改动 7】同样更新这里的群组判断逻辑，确保只处理受监控群的撤回事件
    const isMonitored = config.monitorGroups.some(g => g.groupId === session.channelId)
    if (!isMonitored) return

    const originalMessageId = session.messageId

    // Case 1: 撤回的是被转发过的源消息
    const entryIndex = forwardedHistory.findIndex(entry => entry.originalMessageId === originalMessageId)
    if (entryIndex !== -1) {
      const entry = forwardedHistory[entryIndex]
      if (entry.helperMessageId) {
        try { await session.bot.deleteMessage(session.channelId, entry.helperMessageId) }
        catch (e) { ctx.logger.warn(`[撤回] 助手消息 (ID: ${entry.helperMessageId}) 失败:`, e) }
      }
      try { await session.bot.deleteMessage(config.targetQQ, entry.forwardedMessageId) }
      catch (e) { ctx.logger.warn(`[撤回] 转发消息 (ID: ${entry.forwardedMessageId}) 失败:`, e) }
      finally {
        forwardedHistory.splice(entryIndex, 1)
        ctx.logger.info(`[撤回] 已联动撤回与源消息 ${originalMessageId} 相关的转发。`)
      }
    }

    // Case 2: 撤回的是触发了防复读警告的消息
    if (warningMessageMap.has(originalMessageId)) {
      const warningMessageId = warningMessageMap.get(originalMessageId)
      try { await session.bot.deleteMessage(session.channelId, warningMessageId) }
      catch (e) { ctx.logger.warn(`[撤回] 警告消息 (ID: ${warningMessageId}) 失败:`, e) }
      finally {
        warningMessageMap.delete(originalMessageId)
        ctx.logger.info(`[撤回] 已联动撤回与源消息 ${originalMessageId} 相关的警告。`)
      }
    }
  })
}
