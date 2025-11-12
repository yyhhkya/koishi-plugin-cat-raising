/**
 * @name cat-raising
 * @description 一个用于监控QQ群内B站直播间奖励信息，并自动转发到指定目标的Koishi插件。
 * 它能智能解析非结构化的文本，提取关键信息（直播间号、时间、奖励），并进行去重和信息补全。
 */

import { Context, Schema } from 'koishi'

export const name = 'cat-raising'

// --- 配置 Schema ---
export interface Config {
  targetQQ: string
  isGroup: boolean
  monitorGroups: string[]
  historySize: number
}

export const Config: Schema<Config> = Schema.object({
  targetQQ: Schema.string().description('目标QQ号或QQ群号').required(),
  isGroup: Schema.boolean().description('是否为QQ群').default(false),
  monitorGroups: Schema.array(Schema.string())
    .description('监听的群号列表 (插件只会处理这些群里的消息)')
    .required(),
  historySize: Schema.number()
    .description('用于防复读的历史记录大小，防止短期内对同一活动重复转发')
    .default(30)
    .min(5)
    .max(100),
})

// --- 消息解析模块 ---

/**
 * [核心] 使用算法智能转换文本中的中文数字为阿拉伯数字。
 * 例如： "二十三" -> "23", "一千零八" -> "1008"。
 * @param text 原始文本。
 * @returns 转换后的文本。
 */
function preprocessChineseNumerals(text: string): string {
  const numMap: { [key: string]: number } = {
    '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  };
  const unitMap: { [key: string]: { value: number, isSection: boolean } } = {
    '十': { value: 10, isSection: false },
    '百': { value: 100, isSection: false },
    '千': { value: 1000, isSection: false },
    '万': { value: 10000, isSection: true },
    '亿': { value: 100000000, isSection: true },
  };

  const chineseNumRegex = /([一二三四五六七八九十百千万亿两零]+)/g;

  return text.replace(chineseNumRegex, (match) => {
    if (match.length === 1 && numMap[match] === undefined && unitMap[match] === undefined) {
      return match;
    }
    
    let total = 0;
    let sectionTotal = 0;
    let currentNum = 0;

    for (let i = 0; i < match.length; i++) {
      const char = match[i];
      if (numMap[char] !== undefined) {
        currentNum = numMap[char];
      } else if (unitMap[char]) {
        const { value, isSection } = unitMap[char];
        // 处理 "十" 开头的特殊情况, e.g., "十一" (currentNum为0时，视为1)
        if (value === 10 && currentNum === 0) {
          currentNum = 1;
        }
        
        sectionTotal += currentNum * value;
        currentNum = 0;

        if (isSection) {
          total += sectionTotal;
          sectionTotal = 0;
        }
      }
    }
    total += sectionTotal + currentNum;
    return String(total);
  });
}

interface Reward { amount: number; condition: string }
interface ParsedEvent { dateTime: string; rewards: Reward[] }

/**
 * 从文本中提取所有可能是B站直播间的ID。
 * @param text 待查找的文本。
 * @returns 一个包含所有不重复房间ID的字符串数组。
 */
function extractAllRoomIds(text: string): string[] {
  const patterns = [
    /(?:播间号|房间号|直播间)[:：\s]*(\d{6,15})/g,
    /\b(\d{6,15})\b/g,
  ];
  const foundIds = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) foundIds.add(match[1]);
    }
  }
  return Array.from(foundIds);
}

/**
 * 尝试从单行文本中寻找并格式化时间日期信息。
 * @param line 待解析的单行文本。
 * @returns 格式化后的时间字符串，或 null。
 */
function extractDateTime(line: string): string | null {
  let match;
  if (match = line.match(/(\d{1,2})\s*[月.]\s*(\d{1,2})\s*日?/)) return `${match[1]}月${match[2]}日`;
  if (match = line.match(/每晚\s*(\d{1,2})\s*点/)) return `每晚 ${match[1].padStart(2, '0')}:00`;
  if (match = line.match(/(\d{1,2}\s*月\s*(?:上|中|下)旬)/)) return match[1];
  if (match = line.match(/(\d{1,2})[:：.点时]\s*(\d{1,2})/)) return `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`;
  if (match = line.match(/(\d{1,2})\s*点\s*半/)) return `${match[1].padStart(2, '0')}:30`;
  if (match = line.match(/\b(\d{1,2})\s*[.点时](?!\d)/)) return `${match[1].padStart(2, '0')}:00`;
  if (match = line.match(/(\d{1,2})\s*分/)) {
    const now = new Date();
    const minuteVal = parseInt(match[1]);
    let hourVal = now.getMinutes() > minuteVal ? now.getHours() + 1 : now.getHours();
    return `${(hourVal % 24).toString().padStart(2, '0')}:${match[1].padStart(2, '0')}`;
  }
  if (match = line.match(/.*?(?:生日|周年|新衣|活动).*/)) return match[0].trim();
  return null;
}

/**
 * 从单行文本中解析奖励信息（数量和条件）。
 * @param line 待解析的单行文本。
 * @returns 包含奖励信息的对象数组。
 */
function extractRewards(line: string): Reward[] {
  const rewards: Reward[] = [];
  const regex = /(?:(\d{1,2})\s*级(?:灯牌)?\s*)?(?:发\s*)?(\d+\.?\d*w\+?|\b\d{3,5}\b)(?:神金|钻石|猫猫钻)?/gi;
  let match;
  while ((match = regex.exec(line)) !== null) {
    const condition = match[1] ? `${match[1]}级灯牌` : '无限制';
    let amountStr = (match[2] || '').toLowerCase();
    let amount = amountStr.includes('w') ? parseFloat(amountStr.replace('w', '')) * 10000 : parseFloat(amountStr);
    if (!isNaN(amount) && amount > 0) {
      rewards.push({ amount, condition });
    }
  }
  return rewards;
}

/**
 * 整合解析流程，将完整消息文本转换为结构化的事件数据。
 * @param text 完整的消息内容。
 * @returns 包含解析后事件的数组，如果没有有效信息则返回 null。
 */
function parseEvents(text: string): ParsedEvent[] | null {
  const lines = text.split('\n').filter(line => line.trim());
  let globalDateTime: string | null = null;
  for (const line of lines) {
    const timeInLine = extractDateTime(line);
    if (timeInLine) {
      globalDateTime = timeInLine;
      break;
    }
  }
  const allRewards = lines.flatMap(line => extractRewards(line));
  return allRewards.length > 0 ? [{ dateTime: globalDateTime || '时间未知', rewards: allRewards }] : null;
}

// --- 插件主逻辑 ---

interface ForwardedEntry {
  originalMessageId: string;
  forwardedMessageId: string;
  helperMessageId?: string;
  roomId: string;
  dateTime: string;
}

export function apply(ctx: Context, config: Config) {
  const forwardedHistory: ForwardedEntry[] = [];
  const warningMessageMap = new Map<string, string>();

  // 定义关键词过滤规则，用于智能判断消息价值
  const HARD_REJECTION_KEYWORDS = ['发言榜单']; // 硬性拒绝词，匹配则无条件忽略
  const REJECTION_KEYWORDS = ['签到', '打卡']; // 软性拒绝词，可被覆盖词豁免
  const OVERRIDE_KEYWORDS = ['神金', '发']; // 覆盖词，用于豁免软性拒绝

  ctx.on('message', async (session) => {
    // --- 1. 前置检查 (Guard Clauses) ---
    // 此区域代码用于快速过滤掉明显不符合要求的消息，避免不必要的计算开销。
    const messageForChecks = session.stripped.content;
    const isPureText = session.elements.every(element => element.type === 'text');

    if (!config.monitorGroups.includes(session.channelId)) return;
    if (!isPureText || !messageForChecks.trim()) return;
    if (HARD_REJECTION_KEYWORDS.some(keyword => messageForChecks.includes(keyword))) {
      ctx.logger.info(`消息包含硬性拒绝关键词，已忽略: ${messageForChecks.substring(0, 30)}...`);
      return;
    }
    const triggerRegex = /神金|发|掉落|猫猫钻|w|\b\d{3,5}\b|一千|一百|十|九|八|七|六|五|四|三|两|二|一/i;
    if (!triggerRegex.test(messageForChecks)) return;

    const roomIds = extractAllRoomIds(messageForChecks);
    if (roomIds.length !== 1) return; // 只处理包含唯一房间号的消息
    const roomId = roomIds[0];

    // --- 2. 消息解析与智能过滤 ---
    const preprocessedMessage = preprocessChineseNumerals(messageForChecks);

    const hasRejectionKeyword = REJECTION_KEYWORDS.some(keyword => preprocessedMessage.includes(keyword));
    if (hasRejectionKeyword && !OVERRIDE_KEYWORDS.some(keyword => preprocessedMessage.includes(keyword))) {
      ctx.logger.info(`消息包含软性拒绝关键词且无覆盖词，已忽略: ${messageForChecks.substring(0, 30)}...`);
      return;
    }

    const parsedEvents = parseEvents(preprocessedMessage);
    if (!parsedEvents) return;

    // 弱上下文检查：防止仅有数字而无明确意图（如"发"、"w"）或时间的消息被误判
    const hasStrongContext = /神金|发|w/i.test(preprocessedMessage);
    const hasTime = parsedEvents.some(event => event.dateTime !== '时间未知');
    if (!hasStrongContext && !hasTime) {
      ctx.logger.info(`纯数字信息缺少时间或强上下文，已忽略: ${messageForChecks.substring(0, 30)}...`);
      return;
    }

    // --- 3. 防复读检查 ---
    const currentDateTime = parsedEvents[0].dateTime;
    if (forwardedHistory.some(entry => entry.roomId === roomId && entry.dateTime === currentDateTime)) {
      try {
        const [warningId] = await session.send(`看到啦看到啦，不要发那么多次嘛~`);
        if (warningId) warningMessageMap.set(session.messageId, warningId);
      } catch (e) { ctx.logger.warn('发送重复警告消息失败:', e) }
      return;
    }
    
    // --- 4. 获取B站信息并转发 ---
    let biliInfo = '';
    let helperMessageId: string | undefined = undefined;
    try {
      const roomInfo = await ctx.http.get(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`);
      if (roomInfo?.data?.uid === undefined) throw new Error('无法获取UID');
      
      const statsInfo = await ctx.http.get(`https://api.bilibili.com/x/space/navnum?mid=${roomInfo.data.uid}`);
      if (statsInfo?.data?.video === undefined) throw new Error('无法获取投稿数');
      
      const videoCount = statsInfo.data.video;
      biliInfo = `\n\n---\n用户投稿数: ${videoCount}`;
      const [sentId] = await session.send(`直播间: ${roomId}\n用户投稿数: ${videoCount}`);
      helperMessageId = sentId;
    } catch (error) {
      ctx.logger.warn(`获取直播间 ${roomId} 的B站信息失败: ${error.message}`);
      return; // 获取B站信息是核心功能之一，失败则不应继续转发
    }

    try {
      const forwardMessage = session.content + biliInfo;
      const [forwardedMessageId] = config.isGroup
        ? await session.bot.sendMessage(config.targetQQ, forwardMessage)
        : await session.bot.sendPrivateMessage(config.targetQQ, forwardMessage);
      
      forwardedHistory.push({
        originalMessageId: session.messageId,
        forwardedMessageId,
        helperMessageId,
        roomId,
        dateTime: currentDateTime,
      });
      if (forwardedHistory.length > config.historySize) forwardedHistory.shift();

    } catch (error) {
      session.send('🐱 - 转发失败，请检查配置');
      ctx.logger.error('转发失败:', error);
    }
  });
  
  // --- 撤回逻辑 ---
  ctx.on('message-deleted', async (session) => {
    if (!config.monitorGroups.includes(session.channelId)) return;

    const originalMessageId = session.messageId;
    
    // Case 1: 撤回的是被转发过的源消息
    const entryIndex = forwardedHistory.findIndex(entry => entry.originalMessageId === originalMessageId);
    if (entryIndex !== -1) {
      const entry = forwardedHistory[entryIndex];
      // 联动撤回在监听群发的助手消息
      if (entry.helperMessageId) {
        try { await session.bot.deleteMessage(session.channelId, entry.helperMessageId) }
        catch (e) { ctx.logger.error(`撤回助手消息 (ID: ${entry.helperMessageId}) 失败:`, e) }
      }
      // 联动撤回在目标群/私聊发的转发消息
      try { await session.bot.deleteMessage(config.targetQQ, entry.forwardedMessageId) }
      catch (e) { ctx.logger.error(`撤回转发消息 (ID: ${entry.forwardedMessageId}) 失败:`, e) }
      finally { forwardedHistory.splice(entryIndex, 1) }
    }

    // Case 2: 撤回的是触发了防复读的消息
    if (warningMessageMap.has(originalMessageId)) {
      const warningMessageId = warningMessageMap.get(originalMessageId);
      // 联动撤回机器人发的警告消息
      try { await session.bot.deleteMessage(session.channelId, warningMessageId) }
      catch (e) { ctx.logger.error(`撤回警告消息 (ID: ${warningMessageId}) 失败:`, e) }
      finally { warningMessageMap.delete(originalMessageId) }
    }
  });
}
