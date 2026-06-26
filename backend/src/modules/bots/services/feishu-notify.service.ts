import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface BotAlertInfo {
  friendCode: string;
  remark: string | null;
}

/**
 * 飞书自定义机器人 Webhook 通知服务
 * 用于在 Bot 不可用时发送告警通知到飞书群
 */
@Injectable()
export class FeishuNotifyService {
  private readonly logger = new Logger(FeishuNotifyService.name);
  private readonly webhookUrl: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.webhookUrl = this.config.get<string>('FEISHU_WEBHOOK_URL');
    if (this.webhookUrl) {
      this.logger.log('Feishu webhook notification enabled');
    } else {
      this.logger.warn(
        'FEISHU_WEBHOOK_URL not configured, notifications disabled',
      );
    }
  }

  /**
   * 发送 Bot 不可用告警
   * @param remainingAvailable 当前仍可用的 Bot 数量
   */
  async sendBotUnavailableAlert(
    bots: BotAlertInfo[],
    remainingAvailable: number,
  ): Promise<void> {
    if (!this.webhookUrl || bots.length === 0) return;

    const now = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
    });

    const botLines = bots
      .map((b) => {
        const remark = b.remark ? ` (${b.remark})` : '';
        return `- **${b.friendCode}**${remark}`;
      })
      .join('\n');

    const card = {
      msg_type: 'interactive',
      card: {
        header: {
          title: {
            tag: 'plain_text',
            content: '⚠️ Bot 不可用告警',
          },
          template: 'orange',
        },
        elements: [
          {
            tag: 'markdown',
            content: `**${bots.length} 个 Bot 变为不可用：**\n${botLines}\n\n**当前剩余可用 Bot：** ${remainingAvailable} 个\n**检测时间：** ${now}`,
          },
        ],
      },
    };

    await this.send(card);
  }

  /**
   * 发送所有 Bot 均不可用的紧急告警
   */
  async sendAllBotsDownAlert(bots: BotAlertInfo[]): Promise<void> {
    if (!this.webhookUrl) return;

    const now = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
    });

    const botLines = bots
      .map((b) => {
        const remark = b.remark ? ` (${b.remark})` : '';
        return `- ${b.friendCode}${remark}`;
      })
      .join('\n');

    const card = {
      msg_type: 'interactive',
      card: {
        header: {
          title: {
            tag: 'plain_text',
            content: '🚨 所有 Bot 均不可用',
          },
          template: 'red',
        },
        elements: [
          {
            tag: 'markdown',
            content: `**所有 ${bots.length} 个 Bot 均已不可用，服务已中断！**\n\n${botLines}\n\n请立即检查 Worker 状态和 Bot Cookie。\n\n**检测时间：** ${now}`,
          },
        ],
      },
    };

    await this.send(card);
  }

  /**
   * 发送 Bot 恢复可用通知
   */
  async sendBotRecoveredAlert(bots: BotAlertInfo[]): Promise<void> {
    if (!this.webhookUrl || bots.length === 0) return;

    const now = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
    });

    const botLines = bots
      .map((b) => {
        const remark = b.remark ? ` (${b.remark})` : '';
        return `- **${b.friendCode}**${remark}`;
      })
      .join('\n');

    const card = {
      msg_type: 'interactive',
      card: {
        header: {
          title: {
            tag: 'plain_text',
            content: '✅ Bot 已恢复可用',
          },
          template: 'green',
        },
        elements: [
          {
            tag: 'markdown',
            content: `**${bots.length} 个 Bot 已恢复可用：**\n${botLines}\n\n**检测时间：** ${now}`,
          },
        ],
      },
    };

    await this.send(card);
  }

  /**
   * 发送消息到飞书 Webhook
   */
  private async send(payload: object): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        this.logger.error(
          `Feishu webhook failed: ${res.status} ${res.statusText} - ${text}`,
        );
      } else {
        this.logger.log('Feishu notification sent successfully');
      }
    } catch (err) {
      this.logger.error('Failed to send Feishu notification', err);
    }
  }
}
