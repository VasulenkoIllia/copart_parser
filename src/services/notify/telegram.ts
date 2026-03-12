import axios from "axios";
import env from "../../config/env";
import { logger } from "../../lib/logger";

function isConfigured(): boolean {
  return Boolean(env.telegram.enabled && env.telegram.botToken && env.telegram.chatId);
}

function buildApiUrl(method: string): string {
  return `https://api.telegram.org/bot${env.telegram.botToken}/${method}`;
}

export async function sendTelegramMessage(text: string): Promise<void> {
  if (!isConfigured()) {
    return;
  }

  try {
    await axios.post(
      buildApiUrl("sendMessage"),
      {
        chat_id: env.telegram.chatId,
        text,
        disable_web_page_preview: true,
      },
      {
        timeout: 15_000,
      }
    );
  } catch (error) {
    logger.warn("Failed to send Telegram message", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function sendTelegramError(title: string, error: unknown): Promise<void> {
  if (!env.telegram.sendErrorAlerts) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  await sendTelegramMessage(`[ERROR] ${title}\n${message}`);
}
