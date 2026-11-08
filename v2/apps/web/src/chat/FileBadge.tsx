import { Icon, type IconName } from "../ui/Icon.js";
import { type FileKind, fileExtension, fileKind } from "./attachedFiles.js";

const ICONS: Record<FileKind, IconName> = {
  pdf: "fileText",
  doc: "fileText",
  sheet: "grid",
  slides: "square",
  archive: "file",
  code: "code",
  media: "image",
  other: "file",
};

/** A square tile tinted by file type. The large one spells out the extension; the small one shows an icon. */
export function FileBadge({ path, size = "md" }: { path: string; size?: "sm" | "md" }) {
  const kind = fileKind(path);
  const extension = fileExtension(path);
  return (
    <span className={`file-badge is-${kind}${size === "sm" ? " is-sm" : ""}`} aria-hidden="true">
      {size === "md" && extension && extension.length <= 4 ? (
        <span className="file-badge-text">{extension}</span>
      ) : (
        <Icon name={ICONS[kind]} size={size === "sm" ? 11 : 14} />
      )}
    </span>
  );
}
