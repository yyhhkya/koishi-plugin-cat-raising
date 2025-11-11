import { Context, Schema } from 'koishi'

export const name = 'cat-raising'

// --- 配置 Schema (保持不变) ---
export interface Config {
  targetQQ: string
  isGroup: boolean
  monitorGroup: string
  historySize: number
}

export const Config: Schema<Config> = Schema.object({
  targetQQ: Schema.string().description('目标QQ号或QQ群号').required(),
  isGroup: Schema.boolean().description('是否为QQ群').default(false),
  monitorGroup: Schema.string().description('监听的群号（只检测此群的消息）').required(),
  historySize: Schema.number()
    .description('防复读历史记录大小 (记录最近N条转发信息，防止短期内对同一直播间的同一活动重复转发)')
    .default(30)
    .min(5)
    .max(100),
})

// --- 消息解析模块 (保持不变) ---

interface Reward {
  amount: number;
  condition: string;
}

interface ParsedEvent {
  dateTime: string;
  rewards: Reward[];
}

function extractAllRoomIds(text: string): string[] {
  const patterns = [
    /(?:播间号|房间号|直播间)[:：\s]*(\d{6,15})/g,
    /\b(\d{8,15})\b/g,
  ];
  const foundIds = new Set<string>();
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) foundIds.add(match[1]);
    }
  }
  return Array.from(foundIds);
}

function extractDateTime(line: string): string | null {
  let match = line.match(/(\d{1,2})\s*[月.]\s*(\d{1,2})\s*日?/);
  if (match) return `${match[1]}月${match[2]}日`;
  
  match = line.match(/每晚\s*(\d{1,2})\s*点/);
  if (match) return `每晚 ${match[1].padStart(2, '0')}:00`;
  
  match = line.match(/(\d{1,2}\s*月\s*(?:上|中|下)旬)/);
  if (match) return match[1];
  
  match = line.match(/(\d{1,2})[:：.点时]\s*(\d{1,2})/);
  if (match && match[2]) {
    const hour = match[1].padStart(2, '0');
    const minute = match[2].padStart(2, '0');
    return `${hour}:${minute}`;
  }
  
  match = line.match(/(\d{1,2})\s*点\s*半/);
  if (match) return `${match[1].padStart(2, '0')}:30`;

  match = line.match(/\b(\d{1,2})\s*[.点时](?!\d)/);
  if (match && match[1]) {
    const hour = match[1].padStart(2, '0');
    return `${hour}:00`;
  }
  
  match = line.match(/(\d{1,2})\s*分/);
  if (match) {
    const now = new Date();
    const minuteVal = parseInt(match[1]);
    let hourVal = now.getMinutes() > minuteVal ? now.getHours() + 1 : now.getHours();
    hourVal = hourVal % 24;
    return `${hourVal.toString().padStart(2, '0')}:${match[1].padStart(2, '0')}`;
  }

  match = line.match(/.*?(?:生日|周年|新衣|活动).*/);
  if (match) return match[0].trim();

  return null;
}

function extractRewards(line: string): Reward[] {
  const rewards: Reward[] = [];
  const regex = /(?:(\d{1,2})\s*级(?:灯牌)?\s*)?(?:发\s*)?(\d+\.?\d*w\+?|\b\d{3,5}\b)(?:神金|钻石|猫猫钻)?/gi;
  let match;

  while ((match = regex.exec(line)) !== null) {
    const condition = match[1] ? `${match[1]}级灯牌` : '无限制';
    let amountStr = (match[2] || '').toLowerCase();
    let amount = 0;
    if (amountStr.includes('w')) {
      amount = parseFloat(amountStr.replace('w', '')) * 10000;
    } else {
      amount = parseFloat(amountStr);
    }
    
    if (!isNaN(amount) && amount > 0) {
      rewards.push({ amount, condition });
    }
  }
  return rewards;
}

function parseEvents(text: string): ParsedEvent[] | null {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  const events: ParsedEvent[] = [];

  let globalDateTime: string | null = null;
  for (const line of lines) {
    const timeInLine = extractDateTime(line);
    if (timeInLine) {
      globalDateTime = timeInLine;
      break;
    }
  }

  const allRewards: Reward[] = [];
  for (const line of lines) {
    const rewardsInLine = extractRewards(line);
    allRewards.push(...rewardsInLine);
  }

  if (allRewards.length > 0) {
    events.push({
      dateTime: globalDateTime || '时间未知',
      rewards: allRewards,
    });
  }

  return events.length > 0 ? events : null;
}

// --- 插件主逻辑 (已更新) ---

// [核心改动 1] 在历史记录中增加 helperMessageId
interface ForwardedEntry {
  originalMessageId: string;
  forwardedMessageId: string;
  helperMessageId?: string; // 新增字段，用于存储发回监听群的消息ID
  originalContent: string;
  roomId: string;
  dateTime: string;
}

export function apply(ctx: Context, config: Config) {
  const forwardedHistory: ForwardedEntry[] = [];

  const REJECTION_KEYWORDS = ['签到', '打卡'];
  const OVERRIDE_KEYWORDS = ['神金', '发'];

  ctx.on('message', async (session) => {
    if (session.channelId !== config.monitorGroup) return;

    const originalMessageContent = session.content;
    const messageForChecks = session.stripped.content;
    const messageId = session.messageId;

    const triggerRegex = /神金|发|掉落|猫猫钻|w|\b\d{3,5}\b/i;
    if (!triggerRegex.test(messageForChecks)) {
      return;
    }

    const hasRejectionKeyword = REJECTION_KEYWORDS.some(keyword => messageForChecks.includes(keyword));
    if (hasRejectionKeyword) {
      const hasOverrideKeyword = OVERRIDE_KEYWORDS.some(keyword => messageForChecks.includes(keyword));
      if (!hasOverrideKeyword) {
        ctx.logger.info(`消息包含拒绝关键词且无覆盖词，已忽略: ${messageForChecks.substring(0, 50)}...`);
        return;
      }
    }

    const roomIds = extractAllRoomIds(messageForChecks);
    if (roomIds.length > 1) {
      return;
    }
    
    const roomId = roomIds.length === 1 ? roomIds[0] : null;

    const parsedEvents = parseEvents(messageForChecks);
    if (!parsedEvents || !roomId) {
      return;
    }

    const strongContextRegex = /神金|发|掉落|猫猫钻|w/i;
    const hasStrongContext = strongContextRegex.test(messageForChecks);
    const hasTime = parsedEvents.some(event => event.dateTime !== '时间未知');
    if (!hasStrongContext && !hasTime) {
      ctx.logger.info(`纯数字信息缺少时间，已忽略: ${messageForChecks.replace(/\s+/g, ' ').substring(0, 50)}...`);
      return;
    }

    const currentDateTime = parsedEvents[0].dateTime;

    if (forwardedHistory.some(entry => entry.roomId === roomId && entry.dateTime === currentDateTime)) {
      session.send(`看到啦看到啦，不要发那么多次嘛~`);
      return;
    }

    let biliInfo = '';
    let helperMessageId: string | undefined = undefined; // [核心改动 2] 准备一个变量来存储助手消息ID

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
        // [核心改动 3] 捕获发回监听群消息的ID
        const sentMessageIds = await session.send(`直播间: ${roomId}\n用户投稿数: ${videoCount}`);
        if (sentMessageIds && sentMessageIds.length > 0) {
          helperMessageId = sentMessageIds[0];
        }
      } catch (e) {
        ctx.logger.warn(`向监听群 ${config.monitorGroup} 发送B站信息时失败:`, e);
      }
    } catch (error) {
      ctx.logger.warn(`获取直播间 ${roomId} 的B站信息失败: ${error.message}`);
      return;
    }

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
        helperMessageId: helperMessageId, // [核心改动 4] 存入历史记录
        originalContent: originalMessageContent,
        roomId: roomId,
        dateTime: currentDateTime,
      };
      
      forwardedHistory.push(newEntry);
      if (forwardedHistory.length > config.historySize) {
        forwardedHistory.shift();
      }
    } catch (error) {
      session.send('🐱 - 转发失败，请检查配置');
      ctx.logger.error('转发失败:', error);
    }
  });
  
  // --- 撤回逻辑 (已更新) ---
  ctx.on('message-deleted', async (session) => {
    const originalMessageId = session.messageId;
    const entryIndex = forwardedHistory.findIndex(entry => entry.originalMessageId === originalMessageId);
    
    if (entryIndex !== -1) {
      const entry = forwardedHistory[entryIndex];

      // [核心改动 5] 增加撤回助手消息的逻辑
      // 1. 撤回发回监听群的助手消息
      if (entry.helperMessageId) {
        try {
          // 助手消息在监听群（即当前 session 所在的群）
          await session.bot.deleteMessage(session.channelId, entry.helperMessageId);
          ctx.logger.info(`成功撤回监听群内的助手消息: ${entry.helperMessageId}`);
        } catch (error) {
          ctx.logger.error(`撤回助手消息 (ID: ${entry.helperMessageId}) 失败:`, error);
        }
      }

      // 2. 撤回转发到目标群的主消息
      try {
        await session.bot.deleteMessage(config.targetQQ, entry.forwardedMessageId);
        ctx.logger.info(`成功撤回转发的消息: ${entry.forwardedMessageId}`);
      } catch (error) {
        ctx.logger.error(`撤回转发消息 (ID: ${entry.forwardedMessageId}) 失败:`, error);
      } finally {
        // 无论成功与否，都从历史记录中移除
        forwardedHistory.splice(entryIndex, 1);
      }
    }
  });
}
