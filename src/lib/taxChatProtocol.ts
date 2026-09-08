import type { AgentId, TaxChatProtocolBlock } from "../types";

export interface TaxChatParserState {
  buffer: string;
}

const OPEN_MARKER = "[[TAXCHAT:to=";
const CLOSE_MARKER = "[[/TAXCHAT]]";
const RECIPIENT_PATTERN = /^(?:[a-zA-Z0-9._:-]+|all|user)$/;
const CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function stripTaxChatAnsi(input: string): string {
  return input.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
}

function partialMarkerSuffix(input: string): string {
  const maxLength = Math.min(OPEN_MARKER.length - 1, input.length);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = input.slice(-length);
    if (OPEN_MARKER.startsWith(suffix)) return suffix;
  }
  return "";
}

export function consumeTaxChatChunk(
  state: TaxChatParserState,
  senderId: AgentId,
  chunk: string,
): { state: TaxChatParserState; blocks: TaxChatProtocolBlock[] } {
  let input = `${state.buffer}${stripTaxChatAnsi(chunk)}`;
  const blocks: TaxChatProtocolBlock[] = [];

  while (input) {
    const openIndex = input.indexOf(OPEN_MARKER);
    if (openIndex < 0) {
      input = partialMarkerSuffix(input);
      break;
    }

    const headerEnd = input.indexOf("]]", openIndex + OPEN_MARKER.length);
    if (headerEnd < 0) {
      input = input.slice(openIndex);
      break;
    }

    const header = input.slice(openIndex + OPEN_MARKER.length, headerEnd).trim();
    const recipient = header;
    const closeIndex = input.indexOf(CLOSE_MARKER, headerEnd + 2);
    if (closeIndex < 0) {
      input = input.slice(openIndex);
      break;
    }

    const body = input.slice(headerEnd + 2, closeIndex).trim();
    if (RECIPIENT_PATTERN.test(recipient) && body) {
      blocks.push({
        senderId,
        recipient: recipient as TaxChatProtocolBlock["recipient"],
        body,
      });
    }
    input = input.slice(closeIndex + CLOSE_MARKER.length);
  }

  return { state: { buffer: input }, blocks };
}

export function formatTaxChatDelivery(input: {
  senderName: string;
  senderId: string;
  recipientIds: string[];
  transcript: string;
}): string {
  const recipients = input.recipientIds.length ? input.recipientIds.join(", ") : "the shared room";
  return [
    "",
    "[TaxChat delivery]",
    `From: ${input.senderName} (${input.senderId})`,
    `To: ${recipients}`,
    "",
    "Shared TaxChat transcript:",
    input.transcript.trim(),
    "",
    "Respond normally in this terminal. To send a message to another agent, emit:",
    "[[TAXCHAT:to=agent-id]]",
    "Your message",
    "[[/TAXCHAT]]",
    "",
  ].join("\n");
}
