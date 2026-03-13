import axios from "axios";
import fs from "fs/promises";
import env from "../../config/env";
import { logger } from "../../lib/logger";

export interface TelegramDocument {
  path: string;
  filename?: string;
  caption?: string;
}

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

export async function sendTelegramDocuments(documents: TelegramDocument[]): Promise<void> {
  if (!isConfigured() || documents.length === 0) {
    return;
  }

  for (const document of documents) {
    try {
      const form = new FormData();
      const buffer = await fs.readFile(document.path);
      form.append("chat_id", env.telegram.chatId);
      form.append(
        "document",
        new Blob([buffer], { type: "text/csv; charset=utf-8" }),
        document.filename ?? "report.csv"
      );
      if (document.caption) {
        form.append("caption", document.caption);
      }

      const response = await fetch(buildApiUrl("sendDocument"), {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Telegram sendDocument failed with HTTP ${response.status}`);
      }
    } catch (error) {
      logger.warn("Failed to send Telegram document", {
        path: document.path,
        filename: document.filename ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function sendTelegramError(title: string, error: unknown): Promise<void> {
  if (!env.telegram.sendErrorAlerts) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  await sendTelegramMessage(`[ERROR] ${title}\n${message}`);
}
