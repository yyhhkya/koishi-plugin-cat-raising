import { Context, Schema } from 'koishi'

export const name = 'cat-raising'

// 配置Schema
export interface Config {
  targetQQ: string
  isGroup: boolean
  debugMode: boolean
  monitorGroup: string
}

export const Config: Schema<Config> = Schema.object({
  targetQQ: Schema.string().description('目标QQ号或QQ群号').required(),
  isGroup: Schema.boolean().description('是否为QQ群').default(false),
  debugMode: Schema.boolean().description('调试模式（不执行转发，仅在原消息处发送调试信息）').default(false),
  monitorGroup: Schema.string().description('监听的群号（只检测此群的消息）').required()
})

export function apply(ctx: Context, config: Config) {
  // 监听所有消息
  ctx.on('message', (session) => {
    const message = session.content
    
    // 检查消息是否来自指定的监听群
    if (session.channelId !== config.monitorGroup) return
    
    // 检查消息是否包含"神金"
    if (!message.includes('神金')) return
    
    // 检查消息是否包含6-15位数字
    const numberRegex = /\d{6,15}/
    if (!numberRegex.test(message)) return
    
    // 调试模式：只发送调试信息，不执行转发
    if (config.debugMode) {
      const debugMessage = `🐱 调试模式 - 检测到神金\n` +
        `📤 转发目标: ${config.targetQQ}${config.isGroup ? ' (群聊)' : ''}\n` +
        `💬 检测内容: ${message}\n` +
        `🔍 匹配数字: ${message.match(/\d{6,15}/)?.[0] || '未找到'}\n` +
        `✅ 条件满足，但调试模式下不执行转发`
      
      session.send(debugMessage)
      return
    }
    
    // 正式模式：执行实际转发
    const forwardMessage = message
    
    // 根据配置转发到QQ或QQ群
    if (config.isGroup) {
      // 转发到QQ群
      session.bot.sendMessage(config.targetQQ, forwardMessage)
    } else {
      // 转发到QQ
      session.bot.sendPrivateMessage(config.targetQQ, forwardMessage)
    }
    
    // 回复发送者确认消息已转发
    // session.send('🐱 检测到神金 已执行转发~')
  })
}