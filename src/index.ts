import { Context, Schema } from 'koishi'
import * as crypto from 'crypto'
import { URLSearchParams } from 'url'

export const name = 'cat-raising'

// --- 配置项定义 (Schema) ---

/** B站 access_key 配置项 */
export interface BiliAccessKeyConfig {
  /** Bilibili access_key */
  key: string
  /** 对此 access_key 的备注，例如所属账号 */
  remark?: string
}

/** 监听群组的配置 */
export interface MonitorGroupConfig {
  /** 要监听的 QQ 群号 */
  groupId: string
  /** 是否在此群内发送“看到啦”之类的辅助/警告消息 */
  sendHelperMessages: boolean
}

/** 插件配置 */
export interface Config {
  /** 目标QQ号或QQ群号 */
  targetQQ: string
  /** 目标是否为QQ群 */
  isGroup: boolean
  /** 监听的群组列表及其配置 */
  monitorGroups: MonitorGroupConfig[]
  /** 用于防复读的历史记录大小 */
  historySize: number
  /** 用于发送B站弹幕的 access_key 列表 */
  biliAccessKeys: BiliAccessKeyConfig[]
}

export const Config: Schema<Config> = Schema.object({
  targetQQ: Schema.string().description('目标QQ号或QQ群号').required(),
  isGroup: Schema.boolean().description('是否为QQ群').default(false),
  monitorGroups: Schema.array(Schema.object({
    groupId: Schema.string().description('要监听的 QQ 群号').required(),
    sendHelperMessages: Schema.boolean().description('是否在此群内发送“看到啦”之类的辅助/警告消息').default(true),
  })).description('监听的群组列表及其配置').required(),
  historySize: Schema.number().description('用于防复读的历史记录大小').default(30).min(5).max(100),
  biliAccessKeys: Schema.array(Schema.object({
    key: Schema.string().description('Bilibili access_key').required(),
    remark: Schema.string().description('对此 access_key 的备注'),
  })).description('用于发送B站弹幕的 access_key 列表').default([]),
})

// --- 消息解析模块 ---

/**
 * 智能转换文本中的中文数字为阿拉伯数字。
 * 支持 '十', '百', '千', '万', '亿' 等单位。
 * @param text 包含中文数字的原始文本。
 * @returns 转换后的文本。
 */
function preprocessChineseNumerals(text: string): string {
  const numMap = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
  const unitMap = { '十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000 }
  const chineseNumRegex = /([一二三四五六七八九十百千万亿两零]+)/g
  return text.replace(chineseNumRegex, (match) => {
    let total = 0, tempVal = 0, sectionVal = 0
    for (let i = 0; i < match.length; i++) {
      const char = match[i]
      if (numMap[char] !== undefined) {
        tempVal = numMap[char]
      } else if (unitMap[char]) {
        const unit = unitMap[char]
        if (unit >= 10000) { // 处理 '万', '亿' 等节单位
          sectionVal += tempVal
          total += sectionVal * unit
          sectionVal = 0
        } else { // 处理 '十', '百', '千'
          sectionVal += (tempVal || 1) * unit
        }
        tempVal = 0
      }
    }
    total += sectionVal + tempVal
    return String(total)
  })
}

/** 描述一项奖励的内容 */
interface Reward {
  /** 奖励数量 */
  amount: number
  /** 达成条件，如 '1级灯牌' 或 '无限制' */
  condition: string
}

/** 解析后的事件信息结构 */
interface ParsedEvent {
  /** 事件的日期和时间 */
  dateTime: string
  /** 事件包含的奖励列表 */
  rewards: Reward[]
}

/**
 * 从文本中智能地提取唯一的B站直播间ID。
 * 采用多阶段策略：
 * 1. 优先匹配带明确关键字（如"房间号"）的ID。
 * 2. 若无，则将所有独立数字作为候选。
 * 3. 利用奖励解析结果，从候选者中排除被识别为奖励数量的数字。
 * 4. 若仍有多个候选，则应用启发式规则：选择最长的数字串作为房间号。
 * @param text 待查找的文本，可能包含CQ码。
 * @returns 一个只包含一个最可能房间ID的字符串数组，或在无法确定时返回空数组。
 */
function extractAllRoomIds(text: string): string[] {
  const sanitizedText = text.replace(/<[^>]+>/g, '')
  // 阶段一: 优先匹配带明确关键字的房间号
  const explicitPattern = /(?:播间号|房间号|直播间)[:：\s]*(\d{3,15})/gi
  const explicitIds = new Set<string>()
  for (const match of sanitizedText.matchAll(explicitPattern)) {
    if (match[1]) explicitIds.add(match[1])
  }
  if (explicitIds.size > 0) return Array.from(explicitIds)

  // 阶段二: 匹配所有独立数字作为候选
  const genericPattern = /\b(\d{3,15})\b/g
  const allNumericCandidates = new Set<string>()
  for (const match of sanitizedText.matchAll(genericPattern)) {
    if (match[1]) allNumericCandidates.add(match[1])
  }
  if (allNumericCandidates.size <= 1) return Array.from(allNumericCandidates)
  
  // 阶段三: 利用奖励解析进行上下文排除
  const preprocessedText = preprocessChineseNumerals(sanitizedText)
  const rewards = extractRewards(preprocessedText)
  const rewardAmounts = new Set(rewards.map(r => String(r.amount)))
  
  let filteredIds = Array.from(allNumericCandidates).filter(id => !rewardAmounts.has(id))

  // 阶段四: 启发式决胜局 (Heuristic Tie-Breaker)
  if (filteredIds.length > 1) {
    filteredIds.sort((a, b) => b.length - a.length); // 按长度降序排序
    return [filteredIds[0]]; // 返回最长的数字
  }

  return filteredIds
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
 * 从单行文本中精准解析奖励信息。
 * 采用两阶段策略：
 * 1. 优先识别强关联奖励（带单位如'神金'、'w'或触发词如'发'）。
 * 2. 若未找到，则根据弱关联（如'级牌'）来识别独立的数字。
 * @param line 待解析的单行文本。
 * @returns 包含奖励信息的对象数组。
 */
function extractRewards(line: string): Reward[] {
  const rewards: Reward[] = [];
  const foundAmounts = new Set<number>();

  const addReward = (amount: number, condition: string) => {
    if (!isNaN(amount) && amount > 0 && !foundAmounts.has(amount)) {
      rewards.push({ amount, condition });
      foundAmounts.add(amount);
    }
  };

  // 阶段一：识别强关联奖励
  const strongRegex = /(?:(\d{1,2})\s*级(?:灯牌)?\s*)?(?:(发|掉落)\s*)?(?:(神金|钻石|猫猫钻)\s*(\d+\.?\d*w?|\b\d{3,5}\b)|(\d+\.?\d*w|\b\d{3,5}\b)\s*(?:神金|钻石|猫猫钻|w))/gi;
  for (const match of line.matchAll(strongRegex)) {
    const condition = match[1] ? `${match[1]}级灯牌` : '无限制';
    const amountStr = (match[4] || match[5] || '').toLowerCase();
    const amount = amountStr.includes('w') ? parseFloat(amountStr.replace('w', '')) * 10000 : parseFloat(amountStr);
    addReward(amount, condition);
  }

  // 阶段二：若无强关联奖励，则根据弱关联（如'级牌'）识别
  if (rewards.length === 0) {
    const conditionMatch = line.match(/(\d{1,2})\s*级(?:灯牌)?/);
    if (conditionMatch) {
      const condition = conditionMatch[0];
      const conditionLevel = conditionMatch[1];
      
      // 查找所有不属于条件本身的独立数字
      for (const numMatch of line.matchAll(/\b(\d{3,5})\b/g)) {
        if (numMatch[1] !== conditionLevel) {
          const amount = parseFloat(numMatch[1]);
          addReward(amount, condition);
        }
      }
    }
  }

  return rewards;
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

/** 存储已转发消息的条目，用于防复读和撤回联动 */
interface ForwardedEntry {
  originalMessageId: string
  forwardedMessageId: string
  helperMessageId?: string
  roomId: string
  dateTime: string
}

/** 从 Bilibili API 获取的直播间关联信息 */
interface BiliInfo {
  videoCount: number
}

// --- 常量定义 ---
const HARD_REJECTION_KEYWORDS = ['发言榜单', '投稿数:'] // 包含则立即拒绝
const REJECTION_KEYWORDS = ['签到', '打卡'] // 包含则拒绝，除非有覆盖词
const OVERRIDE_KEYWORDS = ['神金', '发'] // 可覆盖 REJECTION_KEYWORDS
const CHECK_IN_REJECTION_REGEX = /\b\d{2,3}\s*\+/ // 匹配签到模式，如 "110+"
const TRIGGER_REGEX = /神金|发|掉落|猫猫钻|w|\b\d{3,5}\b|一千|一百|十|九|八|七|六|五|四|三|两|二|一/i // 初步筛选消息的触发词
const BILI_APPKEY = '4409e2ce8ffd12b8'
const BILI_APPSECRET = '59b43e04ad6965f34319062b478f83dd'

// --- Bilibili API 模块 ---

/**
 * 为 Bilibili API 请求参数进行签名 (md5)。
 * @param params 未签名的请求参数对象。
 * @param appSecret App Secret.
 * @returns 签名字符串。
 */
function signBilibiliParams(params: Record<string, any>, appSecret: string): string {
  const sortedKeys = Object.keys(params).sort()
  const queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&')
  return crypto.createHash('md5').update(queryString + appSecret).digest('hex')
}

/**
 * 使用指定的 access_key 向B站直播间发送弹幕，并内置频率限制重试逻辑。
 * @param ctx Koishi 上下文。
 * @param keyConfig 包含 access_key 和备注的对象。
 * @param roomId 直播间真实 ID。
 * @param message 要发送的弹幕内容。
 */
async function sendBilibiliDanmaku(ctx: Context, keyConfig: BiliAccessKeyConfig, roomId: string, message: string): Promise<void> {
  const MAX_RETRIES = 4, RETRY_DELAY_MS = 3000, FREQUENCY_LIMIT_KEYWORD = '频率过快'
  const url = 'https://api.live.bilibili.com/xlive/app-room/v1/dM/sendmsg'
  const logIdentifier = keyConfig.remark || keyConfig.key.slice(0, 8)

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    const ts = Math.floor(Date.now() / 1000)
    const baseParams = { access_key: keyConfig.key, actionKey: 'appkey', appkey: BILI_APPKEY, cid: roomId, msg: message, rnd: ts, color: '16777215', fontsize: '25', mode: '1', ts: ts }
    const sign = signBilibiliParams(baseParams, BILI_APPSECRET)
    const params = { ...baseParams, sign }
    const formData = new URLSearchParams()
    for (const key in params) formData.append(key, params[key])

    try {
      const response = await ctx.http.post(url, formData, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 BiliDroid/6.73.1' } })
      if (response.code === 0) {
        ctx.logger.info(`[弹幕] [${logIdentifier}] 成功向直播间 ${roomId} 发送弹幕${attempt > 0 ? ` (重试 ${attempt} 次后)` : `: "${message}"`}`)
        return
      }
      if (response.message?.includes(FREQUENCY_LIMIT_KEYWORD)) {
        if (attempt < MAX_RETRIES) {
          ctx.logger.warn(`[弹幕] [${logIdentifier}] 发送频率过快 (尝试 ${attempt + 1}/${MAX_RETRIES + 1})。准备重试...`)
          continue
        } else {
          ctx.logger.warn(`[弹幕] [${logIdentifier}] 发送频率过快，已达最大重试次数 (${MAX_RETRIES})，放弃发送。`)
          return
        }
      }
      ctx.logger.warn(`[弹幕] [${logIdentifier}] 发送失败，直播间 ${roomId}。原因: ${response.message || '未知错误'}`)
      return
    } catch (error) {
      ctx.logger.error(`[弹幕] [${logIdentifier}] 发送请求时发生网络错误 (尝试 ${attempt + 1})，直播间 ${roomId}:`, error)
      return
    }
  }
}

/**
 * 异步获取B站直播间关联的用户信息（如投稿数）。
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

/**
 * 插件的主应用函数。
 * @param ctx Koishi 上下文。
 * @param config 插件配置。
 */
export function apply(ctx: Context, config: Config) {
  const forwardedHistory: ForwardedEntry[] = []

  ctx.on('message', async (session) => {
    // --- 1. 初始过滤 (Guard Clauses) ---
    const groupConfig = config.monitorGroups.find(g => g.groupId === session.channelId)
    if (!groupConfig) return // 非监听群组

    const strippedContent = session.stripped.content
    if (!strippedContent.trim()) return // 空消息
    if (HARD_REJECTION_KEYWORDS.some(keyword => strippedContent.includes(keyword))) return // 硬拒绝词
    if (CHECK_IN_REJECTION_REGEX.test(strippedContent)) return // 签到模式
    if (!TRIGGER_REGEX.test(strippedContent)) return // 未命中触发词

    // --- 2. 核心信息提取 ---
    const roomIds = extractAllRoomIds(session.content)
    if (roomIds.length !== 1) { // 必须识别出且仅识别出一个房间号
      if (roomIds.length > 1) ctx.logger.info(`[忽略] 消息包含多个可能的房间号: ${roomIds.join(', ')}`)
      return
    }
    const roomId = roomIds[0]

    // --- 3. 内容验证与解析 ---
    const preprocessedMessage = preprocessChineseNumerals(strippedContent)
    if (REJECTION_KEYWORDS.some(k => preprocessedMessage.includes(k)) && !OVERRIDE_KEYWORDS.some(k => preprocessedMessage.includes(k))) return

    const parsedEvent = parseEventFromText(preprocessedMessage)
    if (!parsedEvent) return // 未解析出任何奖励
    // 弱信息过滤：如果既没有强关键词，也没有时间信息，则忽略
    if (!/神金|发|w/i.test(preprocessedMessage) && parsedEvent.dateTime === '时间未知') return

    // --- 4. 外部信息获取与辅助消息 ---
    const biliInfo = await fetchBilibiliInfo(ctx, roomId)
    if (!biliInfo) return // API 获取失败

    let helperMessageId: string | undefined
    if (groupConfig.sendHelperMessages) {
      try {
        [helperMessageId] = await session.send(`直播间: ${roomId}\n投稿数: ${biliInfo.videoCount}`)
      } catch (e) {
        ctx.logger.warn('[消息] 发送辅助信息失败:', e)
      }
    }

    // --- 5. 防复读检查 ---
    const { dateTime } = parsedEvent
    if (forwardedHistory.some(entry => entry.roomId === roomId && entry.dateTime === dateTime)) {
      ctx.logger.info(`[防复读] 检测到重复活动，已发送辅助信息，跳过转发: 房间=${roomId}, 时间=${dateTime}`)
      return
    }

    // --- 6. 转发与弹幕 ---
    try {
      const forwardMessage = `${session.content}\n\n---\n投稿数: ${biliInfo.videoCount}`
      const [forwardedMessageId] = config.isGroup
        ? await session.bot.sendMessage(config.targetQQ, forwardMessage)
        : await session.bot.sendPrivateMessage(config.targetQQ, forwardMessage)

      forwardedHistory.push({ originalMessageId: session.messageId, forwardedMessageId, helperMessageId, roomId, dateTime })
      if (forwardedHistory.length > config.historySize) forwardedHistory.shift()

      if (config.biliAccessKeys?.length > 0) {
        ctx.logger.info(`[弹幕] 准备为 ${config.biliAccessKeys.length} 个账号发送弹幕到直播间 ${roomId}...`)
        const danmakuPromises = config.biliAccessKeys.map(keyConfig => sendBilibiliDanmaku(ctx, keyConfig, roomId, '喵喵喵'))
        Promise.allSettled(danmakuPromises)
      }
    } catch (error) {
      session.send('🐱 - 转发失败，请检查目标QQ/群号配置是否正确')
      ctx.logger.error('[转发] 失败:', error)
    }
  })

  ctx.on('message-deleted', async (session) => {
    if (!config.monitorGroups.some(g => g.groupId === session.channelId)) return

    const originalMessageId = session.messageId
    const entryIndex = forwardedHistory.findIndex(entry => entry.originalMessageId === originalMessageId)
    
    if (entryIndex !== -1) {
      const entry = forwardedHistory[entryIndex]
      // 尝试撤回辅助消息
      if (entry.helperMessageId) {
        try { await session.bot.deleteMessage(session.channelId, entry.helperMessageId) }
        catch (e) { ctx.logger.warn(`[撤回] 助手消息 (ID: ${entry.helperMessageId}) 失败:`, e) }
      }
      // 尝试撤回转发的消息
      try {
        const targetChannel = config.isGroup ? config.targetQQ : `private:${config.targetQQ}`
        await session.bot.deleteMessage(targetChannel, entry.forwardedMessageId)
      }
      catch (e) { ctx.logger.warn(`[撤回] 转发消息 (ID: ${entry.forwardedMessageId}) 失败:`, e) }
      finally {
        forwardedHistory.splice(entryIndex, 1) // 从历史记录中移除
        ctx.logger.info(`[撤回] 已联动撤回与源消息 ${originalMessageId} 相关的转发。`)
      }
    }
  })
}
