import { Context, Schema } from 'koishi'

export const name = 'cat-raising'

// --- 配置 Schema (保持不变) ---
export interface Config {
  targetQQ: string
  isGroup: boolean
  monitorGroup: string
}

export const Config: Schema<Config> = Schema.object({
  targetQQ: Schema.string().description('目标QQ号或QQ群号').required(),
  isGroup: Schema.boolean().description('是否为QQ群').default(false),
  monitorGroup: Schema.string().description('监听的群号（只检测此群的消息）').required()
})

// --- 新版消息解析模块 ---

/**
 * 描述一个具体的奖励项
 */
interface Reward {
  amount: number;
  condition: string; // e.g., "14级灯牌", "20级", "无限制"
}

/**
 * 描述一个完整的事件（时间 + 多个奖励）
 */
interface ParsedEvent {
  dateTime: string; // e.g., "11月28日", "12.10 生日回", "每晚 23:00"
  rewards: Reward[];
}

/**
 * [新] 提取消息中所有的房间号
 * @param text 消息内容
 * @returns 房间号数组
 */
function extractAllRoomIds(text: string): string[] {
  const patterns = [
    /(?:播间号|房间号|直播间)[:：\s]*(\d{6,15})/g,
    /\b(\d{8,15})\b/g, // 独立的8位以上数字
  ];
  const foundIds = new Set<string>();
  for (const pattern of patterns) {
    // 使用 matchAll 来获取所有匹配项
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        foundIds.add(match[1]);
      }
    }
  }
  return Array.from(foundIds);
}

/**
 * [升级] 提取日期和时间
 * @param line 文本行
 * @returns 格式化的日期时间字符串或 null
 */
function extractDateTime(line: string): string | null {
  // 匹配 MM月DD日 或 MM.DD
  let match = line.match(/(\d{1,2})\s*[月.]\s*(\d{1,2})\s*日?/);
  if (match) return `${match[1]}月${match[2]}日`;

  // 匹配 "每晚11点" -> "每晚 23:00"
  match = line.match(/每晚\s*(\d{1,2})\s*点/);
  if (match) return `每晚 ${match[1].padStart(2, '0')}:00`;
  
  // 匹配 "11月中旬"
  match = line.match(/(\d{1,2}\s*月\s*(?:上|中|下)旬)/);
  if (match) return match[1];
  
  // 沿用旧的时间匹配逻辑作为补充
  match = line.match(/(\d{1,2})[:：.点时]\s*(\d{1,2})/);
  if (match) return `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`;
  
  match = line.match(/(\d{1,2})\s*点\s*半/);
  if (match) return `${match[1].padStart(2, '0')}:30`;
  
  match = line.match(/(\d{1,2})\s*分/);
  if (match) {
    const now = new Date();
    const minuteVal = parseInt(match[1]);
    let hourVal = now.getMinutes() > minuteVal ? now.getHours() + 1 : now.getHours();
    hourVal = hourVal % 24;
    return `${hourVal.toString().padStart(2, '0')}:${match[1].padStart(2, '0')}`;
  }

  // 匹配包含 "生日" "周年" 等关键字的行作为日期
  match = line.match(/.*?(?:生日|周年|新衣|活动).*/);
  if (match) return match[0].trim();

  return null;
}

/**
 * [升级] 从单行文本中提取所有奖励
 * @param line 文本行
 * @returns Reward 对象数组
 */
function extractRewards(line: string): Reward[] {
  const rewards: Reward[] = [];
  // 正则表达式：捕获 (条件)? 和 (金额)
  // (?:(\d{1,2})\s*级(?:灯牌)?\s*)?  -> 可选的等级条件
  // (\d+\.?\d*w?\+?)                 -> 金额 (e.g., 2000, 1w, 10w+)
  // (?:神金|钻石|猫猫钻)?             -> 可选的单位
  const regex = /(?:(\d{1,2})\s*级(?:灯牌)?\s*)?(\d+\.?\d*w?\+?)(?:神金|钻石|猫猫钻)?/gi;
  let match;

  while ((match = regex.exec(line)) !== null) {
    const condition = match[1] ? `${match[1]}级灯牌` : '无限制';
    let amountStr = match[2].toLowerCase();
    let amount = 0;
    if (amountStr.includes('w')) {
      amount = parseFloat(amountStr.replace('w', '')) * 10000;
    } else {
      amount = parseInt(amountStr, 10);
    }
    rewards.push({ amount, condition });
  }
  return rewards;
}

/**
 * [重构] 解析消息，提取所有事件
 * @param text 消息内容
 * @returns 事件数组，如果无法解析则返回 null
 */
function parseEvents(text: string): ParsedEvent[] | null {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  const events: ParsedEvent[] = [];
  let currentDateTime: string | null = null;
  
  for (const line of lines) {
    const foundDateTime = extractDateTime(line);
    // 如果一行里同时有时间和奖励，也视为一个独立事件
    const foundRewards = extractRewards(line);

    if (foundDateTime) {
        currentDateTime = foundDateTime;
    }

    if (foundRewards.length > 0) {
        // 如果当前行没有时间，但之前有，就用之前的时间
        const eventTime = currentDateTime || '时间未知';
        events.push({ dateTime: eventTime, rewards: foundRewards });
        // 如果一行内同时有时间和奖励，消耗掉时间，避免影响下一行
        if(foundDateTime) currentDateTime = null;
    }
  }

  return events.length > 0 ? events : null;
}

// --- 插件主逻辑 (已更新) ---

interface ForwardedEntry {
  originalMessageId: string;
  forwardedMessageId: string;
  // 使用消息原文作为去重依据，因为解析复杂事件的签名太困难且易出错
  originalContent: string;
}

export function apply(ctx: Context, config: Config) {
  const forwardedHistory: ForwardedEntry[] = [];
  const HISTORY_SIZE = 30; // 增加历史记录大小

  ctx.on('message', async (session) => {
    if (session.channelId !== config.monitorGroup) return;

    const originalMessageContent = session.content;
    const messageForChecks = session.stripped.content;
    const messageId = session.messageId;

    // --- 1. [新] 唯一房间号检测 ---
    const roomIds = extractAllRoomIds(messageForChecks);

    if (roomIds.length > 1) {
      // session.send(`检测到多个直播间号 (${roomIds.join(', ')})，为避免信息混淆，已停止处理。`);
      return;
    }
    if (roomIds.length === 0) {
        // 如果没有房间号，但包含神金等关键词，也可能是有效信息，先不退出
        // return;
    }
    
    const roomId = roomIds.length === 1 ? roomIds[0] : null;

    // --- 2. [重构] 解析事件 ---
    const parsedEvents = parseEvents(messageForChecks);
    // 必须解析出事件，并且有唯一的房间号，才认为是有效信息
    if (!parsedEvents || !roomId) {
      if (messageForChecks.match(/神金|w|发|掉落|\d{3,5}/)) {
        ctx.logger.info(`消息可能为神金信息但无法完整解析(缺少房间号或事件)，已忽略: ${messageForChecks.substring(0, 50)}...`);
      }
      return;
    }

    // --- 3. [简化] 复读检测 ---
    // 对于复杂消息，直接比对原文是更可靠的去重方式
    if (forwardedHistory.some(entry => entry.originalContent === originalMessageContent)) {
      session.send('看到啦看到啦，不要发那么多次嘛~');
      return;
    }

    // --- 4. 获取B站信息 (使用唯一的房间号) ---
    let biliInfo = '';
    try {
      const roomInfoUrl = `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`;
      const roomInfo = await ctx.http.get(roomInfoUrl);
      if (roomInfo.code !== 0 || !roomInfo.data?.uid) throw new Error('无法通过直播间号获取UID');
      
      const uid = roomInfo.data.uid;
      const statsUrl = `https://api.bilibili.com/x/space/navnum?mid=${uid}`;
      const statsInfo = await ctx.http.get(statsUrl);
      if (statsInfo.code !== 0 || statsInfo.data?.video === undefined) throw new Error('无法获取用户投稿数');

      const videoCount = statsInfo.data.video;
      biliInfo = `\n\n---\n用户投稿数: ${videoCount}`;

      try {
        await session.send(`直播间: ${roomId}\n用户投稿数: ${videoCount}`);
      } catch (e) {
        ctx.logger.warn(`向监听群 ${config.monitorGroup} 发送B站信息时失败:`, e);
      }
    } catch (error) {
      ctx.logger.warn(`获取直播间 ${roomId} 的B站信息失败: ${error.message}`);
    }

    // --- 5. 执行转发 ---
    const forwardMessage = originalMessageContent + biliInfo;
    
    try {
      let forwardedMessageId: string;
      if (config.isGroup) {
        const result = await session.bot.sendMessage(config.targetQQ, forwardMessage);
        forwardedMessageId = result[0];
      } else {
        const result = await session.bot.sendPrivateMessage(config.targetQQ, forwardMessage);
        forwardedMessageId = result[0];
      }
      
      const newEntry: ForwardedEntry = {
        originalMessageId: messageId,
        forwardedMessageId: forwardedMessageId,
        originalContent: originalMessageContent,
      };
      
      forwardedHistory.push(newEntry);
      if (forwardedHistory.length > HISTORY_SIZE) {
        forwardedHistory.shift();
      }
    } catch (error) {
      session.send('🐱 - 转发失败，请检查配置');
      ctx.logger.error('转发失败:', error);
    }
  });
  
  // --- 撤回逻辑 (更新) ---
  ctx.on('message-deleted', async (session) => {
    const originalMessageId = session.messageId;
    const entryIndex = forwardedHistory.findIndex(entry => entry.originalMessageId === originalMessageId);
    
    if (entryIndex !== -1) {
      const entry = forwardedHistory[entryIndex];
      try {
        await session.bot.deleteMessage(config.targetQQ, entry.forwardedMessageId);
        ctx.logger.info(`成功撤回转发的消息: ${entry.forwardedMessageId}`);
      } catch (error) {
        ctx.logger.error(`撤回转发消息 (ID: ${entry.forwardedMessageId}) 失败:`, error);
      } finally {
        forwardedHistory.splice(entryIndex, 1);
      }
    }
  });
}
