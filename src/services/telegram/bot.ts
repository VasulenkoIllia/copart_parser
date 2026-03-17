import axios from "axios";
import env from "../../config/env";
import { logger } from "../../lib/logger";
import { refreshLotFullyByNumber } from "../manual/lot-refresh";
import { isTelegramConfigured, sendTelegramMessage } from "../notify/telegram";

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

export function buildRefreshReply(result: Awaited<ReturnType<typeof refreshLotFullyByNumber>>): string {
  switch (result.status) {
    case "blocked_by_global_refresh":
      return [
        `Лот ${result.lotNumber}: ручне оновлення зараз недоступне.`,
        "Йде глобальне оновлення.",
        `Активні lock-и: ${result.blockingLocks.join(", ") || "невідомо"}`,
      ].join("\n");
    case "blocked_by_manual_refresh":
      return [
        `Лот ${result.lotNumber}: ручне оновлення вже виконується.`,
        `Активні lock-и: ${result.blockingLocks.join(", ") || "невідомо"}`,
      ].join("\n");
    case "lot_not_found_in_core":
      return `Лот ${result.lotNumber} відсутній у core базі. Ручне оновлення не запущено.`;
    case "lot_not_found_in_source":
      return `Лот ${result.lotNumber} є в core, але відсутній у поточному CSV-джерелі.`;
    case "success_without_image_url":
      return [
        `Лот ${result.lotNumber}: core оновлено, але в CSV немає image URL.`,
        `rows_inserted=${result.rowsInserted}`,
        `rows_updated=${result.rowsUpdated}`,
        `rows_unchanged=${result.rowsUnchanged}`,
        `photo_attempts_deleted=${result.clearedPhotoAttempts}`,
        `lot_images_deleted=${result.clearedImages}`,
        `duration_ms=${result.durationMs}`,
      ].join("\n");
    case "success":
      return [
        `Лот ${result.lotNumber}: ручне оновлення завершено.`,
        `rows_inserted=${result.rowsInserted}`,
        `rows_updated=${result.rowsUpdated}`,
        `rows_unchanged=${result.rowsUnchanged}`,
        `rows_updated_image_url_changed=${result.rowsUpdatedImageUrlChanged}`,
        `rows_updated_other_fields=${result.rowsUpdatedOtherFields}`,
        `photo_attempts_deleted=${result.clearedPhotoAttempts}`,
        `images_inserted=${result.photoSummary?.imagesInserted ?? 0}`,
        `images_updated=${result.photoSummary?.imagesUpdated ?? 0}`,
        `images_stored_hd=${result.photoSummary?.imagesStoredHd ?? 0}`,
        `images_stored_full=${result.photoSummary?.imagesStoredFull ?? 0}`,
        `lots_ok=${result.photoSummary?.lotsOk ?? 0}`,
        `lots_missing=${result.photoSummary?.lotsMissing ?? 0}`,
        `duration_ms=${result.durationMs}`,
      ].join("\n");
  }
}

async function handleRefreshCommand(message: TelegramMessage, args: string[]): Promise<void> {
  const lotNumber = parseLotNumberArg(args[0]);
  if (!lotNumber) {
    await sendTelegramMessage(
      "Формат команди: /refresh_lot <lot_number>",
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
