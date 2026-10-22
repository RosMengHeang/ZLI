export type CaptureSourceKind = "window" | "screen";

/** A window or screen the person can attach a picture of. */
export type CaptureSource = { id: string; name: string; kind: CaptureSourceKind; thumbnail?: string };

type NativeImageLike = { isEmpty(): boolean; toDataURL(): string; toPNG(): Uint8Array };
type DesktopSourceLike = { id: string; name: string; thumbnail: NativeImageLike };

export type CaptureDependencies = {
  getSources(options: {
    types: CaptureSourceKind[];
    thumbnailSize: { width: number; height: number };
    fetchWindowIcons: boolean;
  }): Promise<DesktopSourceLike[]>;
  /** The largest display in device pixels, which bounds how sharp a full capture can be. */
  largestDisplay(): { width: number; height: number };
};

const THUMBNAIL = { width: 320, height: 200 };
const MAX_SIDE = 3_840;

export function sourceKind(id: string): CaptureSourceKind {
  return id.startsWith("screen:") ? "screen" : "window";
}

export function captureSize(display: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(display.width, display.height, 1));
  return {
    width: Math.max(1, Math.round(display.width * scale)),
    height: Math.max(1, Math.round(display.height * scale)),
  };
}

/** Windows first, then screens, with small previews for the picker. Windows with no picture are left out. */
export async function listCaptureSources(deps: CaptureDependencies): Promise<CaptureSource[]> {
  const sources = await deps.getSources({
    types: ["window", "screen"],
    thumbnailSize: THUMBNAIL,
    fetchWindowIcons: false,
  });
  return sources
    .filter((source) => !source.thumbnail.isEmpty())
    .map((source) => ({
      id: source.id,
      name: source.name.trim() || (sourceKind(source.id) === "screen" ? "Screen" : "Untitled window"),
      kind: sourceKind(source.id),
      thumbnail: source.thumbnail.toDataURL(),
    }))
    .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "window" ? -1 : 1));
}

export function parseSourceId(input: unknown): string {
  const id = (input as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !/^(window|screen):[\w:.-]{1,200}$/u.test(id))
    throw new Error("Pick a window to capture.");
  return id;
}

/** A full-size PNG of one source, as base64. */
export async function captureSource(
  deps: CaptureDependencies,
  id: string,
): Promise<{ name: string; dataBase64: string }> {
  const sources = await deps.getSources({
    types: [sourceKind(id)],
    thumbnailSize: captureSize(deps.largestDisplay()),
    fetchWindowIcons: false,
  });
  const source = sources.find((candidate) => candidate.id === id);
  if (!source || source.thumbnail.isEmpty()) throw new Error("That window is closed or hidden. Pick another one.");
  return { name: source.name.trim() || "window", dataBase64: Buffer.from(source.thumbnail.toPNG()).toString("base64") };
}
