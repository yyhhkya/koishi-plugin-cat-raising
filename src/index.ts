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
    
    // 检查并提取消息中的6-15位数字
    const numberRegex = /\d{6,15}/
    const match = messageForChecks.match(numberRegex)
    if (!match) return // 如果没有匹配到数字，则直接返回
    
    const roomId = match[0] // 提取到的数字作为直播间号

    // 检查消息内容是否与最近转发的历史消息中的任何一条相同
    if (forwardedMessageHistory.includes(originalMessageContent)) { 
      session.send('看到啦看到啦，不要发那么多次嘛~')
      return
    }
    
    let biliInfo = '' // 用于存储B站信息，默认为空
    try {
      // --- 获取B站投稿数 ---
      
      // 1. 通过直播间号获取用户信息（主要是UID）
      const roomInfoUrl = `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`
      const roomInfo = await ctx.http.get(roomInfoUrl)
      
      if (roomInfo.code !== 0 || !roomInfo.data || !roomInfo.data.uid) {
        throw new Error('无法通过直播间号获取UID')
      }
      const uid = roomInfo.data.uid

      // 2. 通过UID获取用户投稿数
      const statsUrl = `https://api.bilibili.com/x/space/navnum?mid=${uid}`
      const statsInfo = await ctx.http.get(statsUrl)

      if (statsInfo.code !== 0 || !statsInfo.data || statsInfo.data.video === undefined) {
        throw new Error('无法获取用户投稿数')
      }
      const videoCount = statsInfo.data.video

      // 3. 格式化B站信息 (用于转发)
      biliInfo = `\n\n---\n用户投稿数: ${videoCount}`

      // --- 【新增功能】将查询结果也发送回监听群 ---
      try {
        await session.send(`直播间: ${roomId}\n用户投稿数: ${videoCount}`)
      } catch (e) {
        ctx.logger.warn(`向监听群 ${config.monitorGroup} 发送B站信息时失败:`, e)
      }
      // ------------------------------------------

    } catch (error) {
      // 获取B站信息失败时，仅在控制台打印错误，不发送任何提示
      // biliInfo将保持为空字符串，程序将继续执行，只转发原始消息
      ctx.logger.warn(`获取直播间 ${roomId} 的B站信息失败: ${error.message}`)
    }

    // 正式模式：执行实际转发
    // 将B站信息（如果成功获取）附加到原始消息后进行转发
    const forwardMessage = originalMessageContent + biliInfo
    
    try {
      let forwardedMessageId: string
      
      // 根据配置转发到QQ或QQ群
      if (config.isGroup) {
        const result = await session.bot.sendMessage(config.targetQQ, forwardMessage)
        forwardedMessageId = result[0] 
      } else {
        const result = await session.bot.sendPrivateMessage(config.targetQQ, forwardMessage)
        forwardedMessageId = result[0] 
      }
      
      // 存储消息ID映射
      messageMap.set(messageId, forwardedMessageId)
      
      // 更新转发消息历史 (仍然使用原始消息内容来判断复读)
      forwardedMessageHistory.push(originalMessageContent)
      if (forwardedMessageHistory.length > HISTORY_SIZE) {
        forwardedMessageHistory.shift() // 移除最旧的消息
      }
    } catch (error) {
      session.send('🐱 - 转发失败，请检查配置')
      ctx.logger.error('转发失败:', error)
    }
  })
  
  // 监听消息撤回事件
  ctx.on('message-deleted', async (session) => {
    const originalMessageId = session.messageId
    
    if (messageMap.has(originalMessageId)) {
      const forwardedMessageId = messageMap.get(originalMessageId)
      
      try {
        if (config.isGroup) {
          await session.bot.deleteMessage(config.targetQQ, forwardedMessageId)
        } else {
          await session.bot.deleteMessage(config.targetQQ, forwardedMessageId)
        }
        
        messageMap.delete(originalMessageId)
      } catch (error) {
        ctx.logger.error('撤回转发消息失败:', error)
      }
    }
  })
}
