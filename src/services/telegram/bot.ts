import axios from "axios";
import env from "../../config/env";
import { logger } from "../../lib/logger";
import { refreshLotFullyByNumber } from "../manual/lot-refresh";
import { isTelegramConfigured, sendTelegramMessage } from "../notify/telegram";
import { REFRESH_LOT_COMMAND_FORMAT, REFRESH_LOT_COMMAND_GROUP_FORMAT } from "./refresh-command";

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
}

let botStarted = false;

function buildApiUrl(method: string): string {
  return `https://api.telegram.org/bot${env.telegram.botToken}/${method}`;
}

export function normalizeCommand(commandToken: string): string {
  const withoutSlash = commandToken.startsWith("/") ? commandToken.slice(1) : commandToken;
  return withoutSlash.split("@")[0]?.trim().toLowerCase() ?? "";
}

export function parseLotNumberArg(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/[^\d]/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function matchesConfiguredChat(chatId: number): boolean {
  return String(chatId) === env.telegram.chatId.trim();
}

async function getUpdates(offset?: number, timeoutSec: number = env.telegram.pollTimeoutSec): Promise<TelegramUpdate[]> {
  const response = await axios.post<TelegramApiResponse<TelegramUpdate[]>>(
    buildApiUrl("getUpdates"),
    {
      offset,
      timeout: timeoutSec,
      limit: 100,
      allowed_updates: ["message"],
    },
    {
      timeout: (timeoutSec + 10) * 1000,
    }
  );

  return Array.isArray(response.data.result) ? response.data.result : [];
}

async function bootstrapOffset(): Promise<number | undefined> {
  let offset: number | undefined;

  while (true) {
    const updates = await getUpdates(offset, 0);
    if (updates.length === 0) {
      return offset;
    }

    offset = updates[updates.length - 1].update_id + 1;
    if (updates.length < 100) {
      return offset;
    }
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} с`;
  return `${minutes} хв ${seconds} с`;
}

export function buildRefreshReply(result: Awaited<ReturnType<typeof refreshLotFullyByNumber>>): string {
  switch (result.status) {
    case "blocked_by_global_refresh":
      return `Лот ${result.lotNumber}: зараз недоступне — йде глобальне оновлення.`;
    case "blocked_by_manual_refresh":
      return `Лот ${result.lotNumber}: вже виконується ручне оновлення.`;
    case "lot_not_found_in_core":
      return `Лот ${result.lotNumber}: не знайдено в базі.`;
    case "lot_not_found_in_source":
      return `Лот ${result.lotNumber}: є в базі, але відсутній у поточному CSV.`;
    case "success_without_image_url":
      return [
        `Лот ${result.lotNumber}: оновлено (без image URL)`,
        `Час: ${formatDuration(result.durationMs)}`,
      ].join("\n");
    case "success": {
      const photo = result.photoSummary;
      const lines = [`Лот ${result.lotNumber}: оновлено`];
      if (photo) {
        lines.push(`Фото: ${photo.imagesInserted} нових · ${photo.imagesUpdated} оновлених`);
        if (photo.mmemberFallbackAttempted > 0) {
          const failed = photo.mmemberFallbackAttempted - photo.mmemberFallbackOk;
          lines.push(`  Mmember: ${photo.mmemberFallbackAttempted} спроб → ${photo.mmemberFallbackOk} ок (${failed} невдало)`);
        }
        if (photo.lotsMissing > 0) {
          lines.push(`  Без фото: ${photo.lotsMissing}`);
        }
      }
      lines.push(`Час: ${formatDuration(result.durationMs)}`);
      return lines.join("\n");
    }
  }
}

async function handleRefreshCommand(message: TelegramMessage, args: string[]): Promise<void> {
  const lotNumber = parseLotNumberArg(args[0]);
  if (!lotNumber) {
    await sendTelegramMessage(
      [
        "Формат команди:",
        `Приват: ${REFRESH_LOT_COMMAND_FORMAT}`,
        `Група: ${REFRESH_LOT_COMMAND_GROUP_FORMAT}`,
      ].join("\n"),
      {
        chatId: String(message.chat.id),
        replyToMessageId: message.message_id,
      }
    );
    return;
  }

  await sendTelegramMessage(
    `Лот ${lotNumber}: запускаю ручне оновлення.`,
    {
      chatId: String(message.chat.id),
      replyToMessageId: message.message_id,
    }
  );

  try {
    const result = await refreshLotFullyByNumber(lotNumber);
    await sendTelegramMessage(buildRefreshReply(result), {
      chatId: String(message.chat.id),
      replyToMessageId: message.message_id,
    });
  } catch (error) {
    logger.error("Telegram manual lot refresh failed", {
      lotNumber,
      message: error instanceof Error ? error.message : String(error),
    });
    await sendTelegramMessage(
      `Лот ${lotNumber}: ручне оновлення завершилось помилкою.\n${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        chatId: String(message.chat.id),
        replyToMessageId: message.message_id,
      }
    );
  }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!matchesConfiguredChat(message.chat.id)) {
    return;
  }

  const text = message.text?.trim() ?? "";
  if (!text.startsWith("/")) {
    return;
  }

  const [commandToken, ...args] = text.split(/\s+/);
  const command = normalizeCommand(commandToken);

  switch (command) {
    case "refresh_lot":
      await handleRefreshCommand(message, args);
      return;
    default:
      return;
  }
}

export async function startTelegramBotPolling(): Promise<void> {
  if (!isTelegramConfigured() || !env.telegram.pollingEnabled) {
    logger.info("Telegram bot polling disabled", {
      configured: isTelegramConfigured(),
      pollingEnabled: env.telegram.pollingEnabled,
    });
    return;
  }

  if (botStarted) {
    logger.info("Telegram bot polling already started");
    return;
  }

  botStarted = true;
  let offset = await bootstrapOffset();
  logger.info("Telegram bot polling started", {
    chatId: env.telegram.chatId,
    pollTimeoutSec: env.telegram.pollTimeoutSec,
    offset,
  });

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (error) {
      logger.error("Telegram bot polling failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }
}
