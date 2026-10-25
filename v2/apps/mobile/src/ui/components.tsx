import { type ReactNode, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Tone } from "../lib/views.js";
import { mono, type Palette, radius, space, TAP, type, usePalette } from "../theme.js";

/**
 * Pressable with a visible ring while it has keyboard focus, which React Native does not draw on
 * its own. Screen readers draw their own focus indicator.
 */
function Tappable({
  children,
  focusRadius = radius.md,
  onFocus,
  onBlur,
  ...props
}: Omit<PressableProps, "children"> & { children: ReactNode; focusRadius?: number }) {
  const palette = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      {...props}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
    >
      {children}
      {focused ? (
        <View style={[styles.focusRing, { borderColor: palette.accent, borderRadius: focusRadius + 3 }]} />
      ) : null}
    </Pressable>
  );
}

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

export function Button({
  label,
  onPress,
  variant = "secondary",
  disabled = false,
  busy = false,
  busyLabel,
  accessibilityLabel,
  accessibilityHint,
  grow = false,
}: {
  label: string;
  /** For labels a screen reader would read badly, such as arrow glyphs. */
  accessibilityLabel?: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  /** Shown instead of the label while busy, such as "Pairing…". */
  busyLabel?: string;
  accessibilityHint?: string;
  grow?: boolean;
}) {
  const palette = usePalette();
  const colors = buttonColors(palette, variant);
  const inactive = disabled || busy;
  return (
    <Tappable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      disabled={inactive}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        grow ? styles.grow : null,
        {
          backgroundColor: pressed ? colors.pressed : colors.fill,
          borderColor: colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={colors.ink} /> : null}
      <Text style={[styles.buttonLabel, { color: colors.ink }]} numberOfLines={1}>
        {busy && busyLabel ? busyLabel : label}
      </Text>
    </Tappable>
  );
}

function buttonColors(palette: Palette, variant: ButtonVariant) {
  switch (variant) {
    case "primary":
      return { fill: palette.accent, pressed: palette.accentPressed, ink: palette.accentInk, border: palette.accent };
    case "danger":
      return { fill: palette.danger, pressed: palette.dangerPressed, ink: palette.dangerInk, border: palette.danger };
    case "secondary":
      return { fill: palette.raised, pressed: palette.overlay, ink: palette.text, border: palette.borderStrong };
    case "quiet":
      return { fill: "transparent", pressed: palette.raised, ink: palette.link, border: "transparent" };
  }
}

/** The top of every screen: back, title, and one optional action. */
export function Header({
  title,
  subtitle,
  onBack,
  action,
}: {
  title: string;
  subtitle?: string | undefined;
  onBack?: () => void;
  action?: ReactNode;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top + space.sm, backgroundColor: palette.canvas, borderBottomColor: palette.border },
      ]}
    >
      {onBack ? (
        <Tappable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          hitSlop={4}
          style={({ pressed }) => [styles.back, pressed ? { backgroundColor: palette.raised } : null]}
        >
          <Text style={[styles.backLabel, { color: palette.link }]}>
            <Text accessibilityElementsHidden importantForAccessibility="no">
              {"‹ "}
            </Text>
            Back
          </Text>
        </Tappable>
      ) : null}
      <View style={styles.headerText}>
        <Text accessibilityRole="header" style={[styles.headerTitle, { color: palette.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.meta, { color: palette.muted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

export function StatusLabel({ label, tone }: { label: string; tone: Tone }) {
  const palette = usePalette();
  const colors = palette.tones[tone];
  return (
    <View style={[styles.status, { backgroundColor: colors.soft }]}>
      <View style={[styles.statusDot, { backgroundColor: colors.ink }]} />
      <Text style={[styles.statusLabel, { color: colors.ink }]}>{label}</Text>
    </View>
  );
}

export type BannerTone = "info" | "warning" | "error";

export function Banner({
  tone,
  title,
  message,
  action,
}: {
  tone: BannerTone;
  title?: string;
  message: string;
  action?: { label: string; onPress: () => void } | undefined;
}) {
  const palette = usePalette();
  const colors = palette.tones[tone === "error" ? "red" : tone === "warning" ? "amber" : "blue"];
  return (
    <View
      accessibilityRole={tone === "error" ? "alert" : "summary"}
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: colors.soft, borderColor: palette.border }]}
    >
      <View style={styles.bannerText}>
        {title ? <Text style={[styles.bannerTitle, { color: colors.ink }]}>{title}</Text> : null}
        <Text style={[styles.body, { color: palette.text }]}>{message}</Text>
      </View>
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" /> : null}
    </View>
  );
}

export function Field({
  label,
  hint,
  error,
  monospace = false,
  ...input
}: TextInputProps & { label: string; hint?: string | undefined; error?: string | undefined; monospace?: boolean }) {
  const palette = usePalette();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: palette.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={palette.dim}
        selectionColor={palette.accent}
        {...input}
        style={[
          styles.input,
          monospace ? { fontFamily: mono, fontSize: type.meta } : null,
          {
            color: palette.text,
            backgroundColor: palette.well,
            borderColor: error ? palette.tones.red.ink : palette.borderStrong,
          },
          input.style,
        ]}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: palette.tones.red.ink }]}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={[styles.meta, { color: palette.muted }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** A tappable list row. The label is read as one phrase so screen readers do not stop at each part. */
export function Row({
  title,
  subtitle,
  detail,
  status,
  onPress,
  accessibilityHint,
  titleMono = false,
}: {
  title: string;
  subtitle?: string | undefined;
  detail?: string | undefined;
  status?: { label: string; tone: Tone } | undefined;
  onPress: () => void;
  accessibilityHint?: string;
  titleMono?: boolean;
}) {
  const palette = usePalette();
  const spoken = [title, status?.label, subtitle, detail].filter(Boolean).join(", ");
  return (
    <Tappable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? palette.raised : palette.surface, borderColor: palette.border },
      ]}
    >
      <View style={styles.rowTop}>
        <Text
          style={[styles.rowTitle, { color: palette.text }, titleMono ? { fontFamily: mono } : null]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {status ? <StatusLabel label={status.label} tone={status.tone} /> : null}
      </View>
      {subtitle ? (
        <Text style={[styles.meta, { color: palette.muted }]} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      {detail ? (
        <Text style={[styles.body, { color: palette.dim }]} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
    </Tappable>
  );
}

export function SectionTitle({ children, aside }: { children: string; aside?: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={styles.sectionTitle}>
      <Text accessibilityRole="header" style={[styles.sectionLabel, { color: palette.muted }]}>
        {children}
      </Text>
      {aside}
    </View>
  );
}

export function EmptyState({
  title,
  message,
  action,
  busy = false,
}: {
  title: string;
  message?: string | undefined;
  action?: { label: string; onPress: () => void; variant?: ButtonVariant } | undefined;
  busy?: boolean;
}) {
  const palette = usePalette();
  return (
    <View style={styles.empty} accessibilityLiveRegion="polite">
      {busy ? <ActivityIndicator color={palette.muted} accessibilityLabel={title} /> : null}
      <Text style={[styles.emptyTitle, { color: palette.text }]}>{title}</Text>
      {message ? <Text style={[styles.body, styles.center, { color: palette.muted }]}>{message}</Text> : null}
      {action ? <Button label={action.label} onPress={action.onPress} variant={action.variant ?? "secondary"} /> : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const palette = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }, style]}>
      {children}
    </View>
  );
}

/** One option in a single-choice list, drawn as a radio button. */
export function Choice({
  label,
  description,
  checked,
  onPress,
  disabled = false,
  labelMono = false,
}: {
  label: string;
  description?: string | undefined;
  checked: boolean;
  onPress: () => void;
  disabled?: boolean;
  labelMono?: boolean;
}) {
  const palette = usePalette();
  return (
    <Tappable
      accessibilityRole="radio"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={description ? `${label}, ${description}` : label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          borderColor: checked ? palette.accent : palette.borderStrong,
          backgroundColor: pressed ? palette.raised : palette.surface,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <View style={[styles.radio, { borderColor: checked ? palette.accent : palette.dim }]}>
        {checked ? <View style={[styles.radioDot, { backgroundColor: palette.accent }]} /> : null}
      </View>
      <View style={styles.choiceText}>
        <Text style={[styles.body, { color: palette.text }, labelMono ? { fontFamily: mono } : null]}>{label}</Text>
        {description ? <Text style={[styles.meta, { color: palette.muted }]}>{description}</Text> : null}
      </View>
    </Tappable>
  );
}

export const styles = StyleSheet.create({
  focusRing: { position: "absolute", top: -3, left: -3, right: -3, bottom: -3, borderWidth: 2, pointerEvents: "none" },
  choice: {
    minHeight: TAP,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  choiceText: { flex: 1, gap: 2 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  button: {
    minHeight: TAP,
    minWidth: TAP,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  grow: { flexGrow: 1, flexBasis: 0 },
  buttonLabel: { fontSize: type.label, fontWeight: "600" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: {
    minHeight: TAP,
    minWidth: TAP,
    justifyContent: "center",
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  backLabel: { fontSize: type.label, fontWeight: "500" },
  headerText: { flex: 1, minHeight: TAP, justifyContent: "center" },
  headerTitle: { fontSize: type.title, fontWeight: "600" },
  meta: { fontSize: type.meta, lineHeight: 18 },
  body: { fontSize: type.body, lineHeight: 22 },
  center: { textAlign: "center" },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: 999,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusLabel: { fontSize: type.meta, fontWeight: "600" },
  banner: {
    margin: space.lg,
    marginBottom: 0,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  bannerText: { gap: 2 },
  bannerTitle: { fontSize: type.body, fontWeight: "600" },
  field: { gap: space.xs },
  fieldLabel: { fontSize: type.meta, fontWeight: "600" },
  input: {
    minHeight: TAP,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: type.body,
  },
  row: {
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
    justifyContent: "center",
  },
  rowTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  rowTitle: { flex: 1, fontSize: type.body, fontWeight: "600" },
  sectionTitle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    marginTop: space.lg,
    minHeight: 28,
  },
  sectionLabel: { fontSize: type.body, fontWeight: "600" },
  empty: { alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xl, flexGrow: 1 },
  emptyTitle: { fontSize: type.title, fontWeight: "600", textAlign: "center" },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.md },
});
