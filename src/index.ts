import { Context, Schema } from 'koishi'

export const name = 'cat-raising'

// 配置Schema
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

export function apply(ctx: Context, config: Config) {
  // 存储最近转发的N条消息内容，用于复读机检测
  const forwardedMessageHistory: string[] = []
  const HISTORY_SIZE = 10 // 检测最近10条转发消息

  // 存储消息ID映射：原始消息ID -> 转发消息ID
  const messageMap = new Map<string, string>()
  
  // 监听所有消息
  ctx.on('message', async (session) => {
    // 使用 session.content 存储原始消息，用于转发
    const originalMessageContent = session.content 
    // 使用 session.stripped.content 进行条件判断，去除 @ 等格式标签
    const messageForChecks = session.stripped.content 
    const messageId = session.messageId
    
    // 检查消息是否来自指定的监听群
    if (session.channelId !== config.monitorGroup) return
    
    // 检查消息是否包含"神金" (使用去除格式后的文本)
    if (!messageForChecks.includes('神金')) return
    
    // 检查消息是否包含6-15位数字 (使用去除格式后的文本)
    const numberRegex = /\d{6,15}/
    if (!numberRegex.test(messageForChecks)) return
    
    // 检查消息内容是否与最近转发的历史消息中的任何一条相同
    // 如果你希望即使 @ 不同人，但文本内容一样也算复读，就用 messageForChecks
    // 如果你希望 @ 不同人就不是复读，用 originalMessageContent
    if (forwardedMessageHistory.includes(originalMessageContent)) { 
      session.send('🐱 - 检测到复读机行为，停止转发')
      return
    }
    
    // 正式模式：执行实际转发
    // 转发时，我们通常希望转发原始消息，包括 @ 提醒
    const forwardMessage = originalMessageContent 
    
    try {
      let forwardedMessageId: string
      
      // 根据配置转发到QQ或QQ群
      if (config.isGroup) {
        // 转发到QQ群
        const result = await session.bot.sendMessage(config.targetQQ, forwardMessage)
        forwardedMessageId = result[0] 
      } else {
        // 转发到QQ
        const result = await session.bot.sendPrivateMessage(config.targetQQ, forwardMessage)
        forwardedMessageId = result[0] 
      }
      
      // 存储消息ID映射
      messageMap.set(messageId, forwardedMessageId)
      
      // 更新转发消息历史
      forwardedMessageHistory.push(originalMessageContent)
      if (forwardedMessageHistory.length > HISTORY_SIZE) {
        forwardedMessageHistory.shift() // 移除最旧的消息
      }
    } catch (error) {
      session.send('🐱 - 转发失败，请检查配置')
      console.error('转发失败:', error)
    }
  })
  
  // 监听消息撤回事件
  ctx.on('message-deleted', async (session) => {
    const originalMessageId = session.messageId
    
    // 检查是否是我们转发的消息
    if (messageMap.has(originalMessageId)) {
      const forwardedMessageId = messageMap.get(originalMessageId)
      
      try {
        // 撤回转发的消息
        // 这里的 config.targetQQ 是发送目标的 id，而不是原始消息来源的 id
        // 注意：Koishi的deleteMessage方法通常需要 channelId 和 messageId。
        // 对于群聊，channelId 就是 targetQQ。对于私聊，channelId 可能是 undefined 或 targetQQ。
        // 最好是根据 isGroup 来判断
        if (config.isGroup) {
          await session.bot.deleteMessage(config.targetQQ, forwardedMessageId)
        } else {
          // 对于私聊，Koishi的bot.deleteMessage可能需要一个明确的私聊会话ID
          // 但通常情况下，只要知道消息ID，bot就能处理
          await session.bot.deleteMessage(config.targetQQ, forwardedMessageId) // targetQQ 在私聊语境下实际是用户ID
        }
        
        // 从映射中移除
        messageMap.delete(originalMessageId)
      } catch (error) {
        console.error('撤回转发消息失败:', error)
      }
    }
  })
}
