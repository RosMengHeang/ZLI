import type { PermissionMode, ProviderDiscovery, ThreadProjection } from "@zli-v2/contracts";
import { useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";

import { useLink } from "../LinkContext.js";
import { attachmentUploads, MAX_ATTACHMENTS, type PhotoDraft } from "../lib/attachments.js";
import { sendCommand } from "../lib/launch.js";
import { PERMISSIONS, permissionColor, permissionOption } from "../lib/permissions.js";
import { newId } from "../platform.js";
import { radius, space, TAP, type, usePalette } from "../theme.js";
import { Chip, IconButton, Sheet, SheetOption, StopButton, Tappable } from "../ui/components.js";
import { Icon } from "../ui/Icon.js";
import { ModelMark } from "../ui/ProviderMark.js";
import { pickPhotos, takePhoto } from "../ui/photos.js";

type SheetKind = "attach" | "model" | "permission";

/**
 * The desktop composer on a phone: the message, then one row with + for photos, the Model and
 * Permissions chips, and Send. A model or permission picked here goes with each message.
 */
export function Composer({
  thread,
  name,
  provider,
  hasMessages,
  online,
  running,
  interrupting,
  onInterrupt,
  onError,
}: {
  thread: ThreadProjection;
  name: string;
  provider: ProviderDiscovery | undefined;
  hasMessages: boolean;
  online: boolean;
  running: boolean;
  interrupting: boolean;
  onInterrupt: () => void;
  onError: (message: string | undefined) => void;
}) {
  const link = useLink();
  const palette = usePalette();
  const { height } = useWindowDimensions();
  const [draft, setDraft] = useState("");
  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState<SheetKind>();
  const [model, setModel] = useState<string | undefined>(thread.model);
  const threadMode: PermissionMode = thread.permissionMode ?? "full-access";
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(threadMode);
  useEffect(() => setPermissionMode(threadMode), [threadMode]);

  const models = provider?.status === "found" ? (provider.models ?? []) : [];
  const modelLabel = model ? (models.find((candidate) => candidate.id === model)?.label ?? model) : "Default model";
  const modelLocked = thread.capabilities.modelSwitch === "unsupported" && hasMessages;
  const permissionSwitch = thread.capabilities.permissionSwitch === "in-session";
  const permission = permissionOption(permissionMode) ?? PERMISSIONS[PERMISSIONS.length - 1];
  const room = MAX_ATTACHMENTS - photos.length;
  const canSend = online && draft.trim().length > 0 && !sending && !attaching;

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    onError(undefined);
    const outcome = await sendCommand(
      link,
      {
        type: "thread.queue",
        threadId: thread.threadId,
        queueId: newId(),
        text,
        ...(model ? { model } : {}),
        ...(permissionSwitch && permissionMode !== threadMode ? { permissionMode } : {}),
        ...(photos.length > 0 ? { attachments: attachmentUploads(photos) } : {}),
      },
      "The message did not reach the desktop.",
    );
    setSending(false);
    if (outcome.ok) {
      setDraft("");
      setPhotos([]);
    } else {
      onError(outcome.error);
    }
  };

  const attach = async (source: "library" | "camera") => {
    setSheet(undefined);
    setAttaching(true);
    onError(undefined);
    const outcome = source === "library" ? await pickPhotos(room, photos.length) : await takePhoto(photos.length);
    setAttaching(false);
    if ("error" in outcome) onError(outcome.error);
    else if (outcome.photos.length > 0)
      setPhotos((current) => [...current, ...outcome.photos].slice(0, MAX_ATTACHMENTS));
  };

  return (
    <View
      style={[
        local.composer,
        {
          backgroundColor: focused ? palette.overlay : palette.raised,
          borderColor: focused ? palette.accent : palette.border,
        },
      ]}
    >
      {photos.length > 0 || attaching ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={local.photos}
        >
          {photos.map((photo) => (
            <View key={photo.id} style={local.photo}>
              <Image
                source={{ uri: photo.uri }}
                style={[local.thumb, { backgroundColor: palette.well }]}
                accessibilityLabel={photo.name}
              />
              <Tappable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${photo.name}`}
                hitSlop={10}
                focusRadius={12}
                onPress={() => setPhotos((current) => current.filter((entry) => entry.id !== photo.id))}
                style={[local.remove, { backgroundColor: palette.canvas, borderColor: palette.borderStrong }]}
              >
                <Icon name="x" size={13} color={palette.text} strokeWidth={2.25} />
              </Tappable>
            </View>
          ))}
          {attaching ? (
            <View
              style={[local.thumb, local.loading, { backgroundColor: palette.well }]}
              accessibilityLabel="Preparing photos"
            >
              <Icon name="image" size={20} color={palette.dim} />
            </View>
          ) : null}
        </ScrollView>
      ) : null}
      <TextInput
        accessibilityLabel={`Message to ${name}`}
        value={draft}
        onChangeText={setDraft}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={
          photos.length > 0
            ? "Say what to do with the photos"
            : running
              ? "Sends when this turn ends"
              : `Message ${name}`
        }
        placeholderTextColor={palette.dim}
        selectionColor={palette.accent}
        cursorColor={palette.accent}
        multiline
        style={[local.input, { color: palette.text }]}
      />
      <View style={local.footer}>
        <IconButton
          icon="plus"
          label="Attach photos"
          variant="plain"
          busy={attaching}
          disabled={!online || room === 0}
          {...(room === 0 ? { accessibilityHint: `A message takes up to ${MAX_ATTACHMENTS} photos` } : {})}
          onPress={() => setSheet("attach")}
        />
        <View style={[local.rule, { backgroundColor: palette.borderStrong }]} />
        {models.length > 0 || model ? (
          <Chip
            label={modelLabel}
            dimLabel={!model}
            leading={<ModelMark id={model} label={modelLabel} size={16} color={palette.text} />}
            accessibilityLabel={`Model, ${modelLabel}`}
            {...(modelLocked || models.length === 0 ? {} : { onPress: () => setSheet("model") })}
          />
        ) : null}
        {permission ? (
          <Chip
            label={permission.label}
            leading={<Icon name={permission.icon} size={16} color={permissionColor(permission.mode, palette)} />}
            accessibilityLabel={`Permissions, ${permission.label}`}
            {...(permissionSwitch ? { onPress: () => setSheet("permission") } : {})}
          />
        ) : null}
        <View style={local.spacer} />
        {running ? (
          <StopButton
            label="Interrupt this turn"
            running={running}
            stopping={interrupting}
            disabled={!online}
            onPress={onInterrupt}
          />
        ) : null}
        <IconButton
          icon="arrowUp"
          label={running ? "Queue message" : "Send"}
          variant="primary"
          busy={sending}
          disabled={!canSend}
          onPress={() => void send()}
        />
      </View>

      <Sheet
        visible={sheet === "attach"}
        title="Attach photos"
        subtitle={`Up to ${room} more with this message. They are sent smaller, as JPEG.`}
        onClose={() => setSheet(undefined)}
      >
        <SheetOption
          icon="image"
          label="Photo library"
          description="Pick photos or screenshots from this phone."
          onPress={() => void attach("library")}
        />
        <SheetOption
          icon="camera"
          label="Take a photo"
          description="Use the camera, for a screen or a sketch."
          onPress={() => void attach("camera")}
        />
      </Sheet>

      <Sheet
        visible={sheet === "model"}
        title="Model"
        subtitle="Used from the next message on."
        onClose={() => setSheet(undefined)}
      >
        <ScrollView style={{ maxHeight: height * 0.6 }}>
          <SheetOption
            leading={<ModelMark id={undefined} size={20} color={palette.muted} />}
            label="Default model"
            description={`Whatever ${name} uses unless told otherwise.`}
            checked={model === undefined}
            onPress={() => {
              setModel(undefined);
              setSheet(undefined);
            }}
          />
          {models.map((candidate) => (
            <SheetOption
              key={candidate.id}
              leading={<ModelMark id={candidate.id} label={candidate.label} size={20} color={palette.text} />}
              label={candidate.label}
              checked={candidate.id === model}
              onPress={() => {
                setModel(candidate.id);
                setSheet(undefined);
              }}
            />
          ))}
        </ScrollView>
      </Sheet>

      <Sheet
        visible={sheet === "permission"}
        title="Permissions"
        subtitle="Applies from the next message on."
        onClose={() => setSheet(undefined)}
      >
        {PERMISSIONS.map((option) => (
          <SheetOption
            key={option.mode}
            leading={<Icon name={option.icon} size={20} color={permissionColor(option.mode, palette)} />}
            label={option.label}
            description={option.description}
            checked={option.mode === permissionMode}
            onPress={() => {
              setPermissionMode(option.mode);
              setSheet(undefined);
            }}
          />
        ))}
      </Sheet>
    </View>
  );
}

const local = StyleSheet.create({
  composer: {
    paddingHorizontal: space.xs + 2,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    borderRadius: radius.composer,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  photos: { gap: space.sm, paddingHorizontal: space.sm, paddingTop: space.sm + 2, paddingBottom: space.xs },
  photo: { paddingTop: 6, paddingRight: 6 },
  thumb: { width: 64, height: 64, borderRadius: radius.sm + 2 },
  loading: { alignItems: "center", justifyContent: "center", marginTop: 6 },
  remove: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    minHeight: TAP,
    maxHeight: 160,
    paddingHorizontal: space.md,
    paddingTop: 11,
    paddingBottom: 6,
    ...type.body,
  },
  footer: { flexDirection: "row", alignItems: "center", gap: 2 },
  rule: { width: StyleSheet.hairlineWidth, height: 18, marginHorizontal: space.xs },
  spacer: { flex: 1, minWidth: space.xs },
});
