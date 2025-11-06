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
  // 存储上一次转发的消息内容
  let lastForwardedMessage = ''
  // 存储消息ID映射：原始消息ID -> 转发消息ID
  const messageMap = new Map<string, string>()
  
  // 监听所有消息
  ctx.on('message', async (session) => {
    const message = session.content
    const messageId = session.messageId
    
    // 检查消息是否来自指定的监听群
    if (session.channelId !== config.monitorGroup) return
    
    // 检查消息是否包含"神金"
    if (!message.includes('神金')) return
    
    // 检查消息是否包含6-15位数字
    const numberRegex = /\d{6,15}/
    if (!numberRegex.test(message)) return
    
    // 检查消息内容是否与上一次相同
    if (message === lastForwardedMessage) {
      session.send('🐱 - 检测到复读机行为，停止转发')
      return
    }
    
    // 正式模式：执行实际转发
    const forwardMessage = message
    
    try {
      let forwardedMessageId: string
      
      // 根据配置转发到QQ或QQ群
      if (config.isGroup) {
        // 转发到QQ群
        const result = await session.bot.sendMessage(config.targetQQ, forwardMessage)
        forwardedMessageId = result[0] // 适配不同平台的消息ID返回格式
      } else {
        // 转发到QQ
        const result = await session.bot.sendPrivateMessage(config.targetQQ, forwardMessage)
        forwardedMessageId = result[0] // 适配不同平台的消息ID返回格式
      }
      
      // 存储消息ID映射
      messageMap.set(messageId, forwardedMessageId)
      
      // 更新上一次转发的消息内容
      lastForwardedMessage = message
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
        if (config.isGroup) {
          // 撤回群消息
          await session.bot.deleteMessage(config.targetQQ, forwardedMessageId)
        } else {
          // 撤回私聊消息（如果平台支持）
          await session.bot.deleteMessage(config.targetQQ, forwardedMessageId)
        }
        
        // 从映射中移除
        messageMap.delete(originalMessageId)
      } catch (error) {
        console.error('撤回转发消息失败:', error)
      }
    }
  })
}