import { Children, Fragment, isValidElement, type ReactNode, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Rect } from "react-native-svg";

import type { Tone } from "../lib/views.js";
import { mono, type Palette, radius, space, TAP, type, usePalette } from "../theme.js";
import { Icon, type IconName } from "./Icon.js";

/**
 * Pressable with a visible ring while it has keyboard focus, which React Native does not draw on
 * its own. Screen readers draw their own focus indicator.
 */
export function Tappable({
  children,
  focusRadius = radius.md,
  onFocus,
  onBlur,
  ...props
}: Omit<PressableProps, "children"> & {
  children: ReactNode | ((state: PressableStateCallbackType) => ReactNode);
  focusRadius?: number;
}) {
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
      {(state) => (
        <>
          {typeof children === "function" ? children(state) : children}
          {focused ? (
            <View style={[styles.focusRing, { borderColor: palette.accent, borderRadius: focusRadius + 3 }]} />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

export function Button({
  label,
  onPress,
  variant = "secondary",
  icon,
  size = "md",
  disabled = false,
  busy = false,
  busyLabel,
  accessibilityLabel,
  accessibilityHint,
  grow = false,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  /** `lg` is for the one action a screen exists for, such as Pair or Start. */
  size?: "md" | "lg";
  disabled?: boolean;
  busy?: boolean;
  /** Shown instead of the label while busy, such as "Pairing…". */
  busyLabel?: string;
  /** For labels a screen reader would read badly, such as arrow glyphs. */
  accessibilityLabel?: string;
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
        size === "lg" ? styles.buttonLarge : null,
        grow ? styles.grow : null,
        { backgroundColor: pressed ? colors.pressed : colors.fill, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.ink} />
      ) : icon ? (
        <Icon name={icon} size={18} color={colors.ink} />
      ) : null}
      <Text style={[styles.buttonLabel, { color: colors.ink }]} numberOfLines={1}>
        {busy && busyLabel ? busyLabel : label}
      </Text>
    </Tappable>
  );
}

function buttonColors(palette: Palette, variant: ButtonVariant) {
  switch (variant) {
    case "primary":
      return { fill: palette.accent, pressed: palette.accentPressed, ink: palette.accentInk };
    case "danger":
      return { fill: palette.raised, pressed: palette.overlay, ink: palette.tones.red.ink };
    case "secondary":
      return { fill: palette.raised, pressed: palette.overlay, ink: palette.text };
    case "quiet":
      return { fill: "transparent", pressed: palette.raised, ink: palette.text };
  }
}

/** A round icon-only button. `label` is what a screen reader says. */
export function IconButton({
  icon,
  label,
  onPress,
  variant = "raised",
  disabled = false,
  busy = false,
  accessibilityHint,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  variant?: "raised" | "plain" | "primary";
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const palette = usePalette();
  const fill = variant === "primary" ? palette.accent : variant === "raised" ? palette.raised : "transparent";
  const pressedFill =
    variant === "primary" ? palette.accentPressed : variant === "raised" ? palette.overlay : palette.raised;
  const ink = variant === "primary" ? palette.accentInk : palette.text;
  const inactive = disabled || busy;
  return (
    <Tappable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      disabled={inactive}
      onPress={onPress}
      hitSlop={4}
      focusRadius={TAP / 2}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: pressed ? pressedFill : fill, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={ink} /> : <Icon name={icon} size={20} color={ink} />}
    </Tappable>
  );
}

/**
 * The top of every screen. `large` is for the home screen: a big title with the actions beside it.
 * Other screens get Back, an optional mark, the title, and their actions.
 */
export function Header({
  title,
  subtitle,
  subtitleMono = false,
  leading,
  onBack,
  actions,
  large = false,
}: {
  title: string;
  subtitle?: ReactNode;
  subtitleMono?: boolean;
  leading?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  large?: boolean;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const sub =
    typeof subtitle === "string" ? (
      <Text style={[styles.meta, { color: palette.muted }, subtitleMono ? styles.mono : null]} numberOfLines={1}>
        {subtitle}
      </Text>
    ) : (
      subtitle
    );
  if (large) {
    return (
      <View style={[styles.largeHeader, { paddingTop: insets.top + space.md }]}>
        <View style={styles.headerText}>
          <Text
            accessibilityRole="header"
            style={[styles.largeTitle, { color: palette.text }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
          >
            {title}
          </Text>
          {sub}
        </View>
        {actions ? <View style={styles.headerActions}>{actions}</View> : null}
      </View>
    );
  }
  return (
    <View style={[styles.header, { paddingTop: insets.top + space.xs }]}>
      {onBack ? <IconButton icon="arrowLeft" label="Back" variant="plain" onPress={onBack} /> : null}
      {leading ? <View style={styles.headerLeading}>{leading}</View> : null}
      <View style={styles.headerText}>
        <Text accessibilityRole="header" style={[styles.headerTitle, { color: palette.text }]} numberOfLines={1}>
          {title}
        </Text>
        {sub}
      </View>
      {actions ? <View style={styles.headerActions}>{actions}</View> : null}
    </View>
  );
}

export function StatusDot({ tone }: { tone: Tone }) {
  const palette = usePalette();
  return <View style={[styles.statusDot, { backgroundColor: palette.tones[tone].ink }]} />;
}

/** A process or connection state: a dot and a word in the state's color. */
export function StatusText({ label, tone }: { label: string; tone: Tone }) {
  const palette = usePalette();
  return (
    <View style={styles.status}>
      <StatusDot tone={tone} />
      <Text style={[styles.statusLabel, { color: palette.tones[tone].ink }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export type NoticeTone = "info" | "warning" | "error";

/** Says what happened next to the thing it is about, and what to do next. */
export function Notice({
  tone,
  title,
  message,
  action,
}: {
  tone: NoticeTone;
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
      style={[styles.notice, { backgroundColor: colors.soft }]}
    >
      <View style={styles.noticeIcon}>
        <Icon name="alert" size={18} color={colors.ink} />
      </View>
      <View style={styles.noticeText}>
        {title ? <Text style={[styles.noticeTitle, { color: palette.text }]}>{title}</Text> : null}
        <Text selectable style={[styles.footnote, { color: palette.text }]}>
          {message}
        </Text>
        {action ? (
          <View style={styles.noticeAction}>
            <Button label={action.label} onPress={action.onPress} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function Field({
  label,
  hint,
  error,
  monospace = false,
  ...input
}: TextInputProps & {
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  monospace?: boolean;
}) {
  const palette = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.fieldLabel, { color: palette.muted }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={palette.dim}
        selectionColor={palette.accent}
        cursorColor={palette.accent}
        {...(label ? { accessibilityLabel: label } : {})}
        {...input}
        onFocus={(event) => {
          setFocused(true);
          input.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          input.onBlur?.(event);
        }}
        style={[
          styles.input,
          monospace ? styles.inputMono : null,
          {
            color: palette.text,
            backgroundColor: palette.well,
            borderColor: error ? palette.tones.red.ink : focused ? palette.accent : palette.border,
          },
          input.style,
        ]}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.fieldNote, { color: palette.tones.red.ink }]}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={[styles.fieldNote, { color: palette.muted }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/**
 * A titled island of rows with hairline dividers between them, the way grouped lists read on a
 * phone. `well` sinks it, for a list inside another island.
 */
export function Section({
  title,
  aside,
  footer,
  tone = "surface",
  children,
}: {
  title?: string | undefined;
  aside?: ReactNode;
  footer?: string | undefined;
  tone?: "surface" | "well";
  children: ReactNode;
}) {
  const palette = usePalette();
  const items = Children.toArray(children);
  return (
    <View style={styles.section}>
      {title || aside ? (
        <View style={styles.sectionHead}>
          {title ? (
            <Text accessibilityRole="header" style={[styles.sectionTitle, { color: palette.muted }]} numberOfLines={1}>
              {title}
            </Text>
          ) : (
            <View style={styles.grow} />
          )}
          {aside}
        </View>
      ) : null}
      {items.length > 0 ? (
        <View style={[styles.island, { backgroundColor: tone === "well" ? palette.well : palette.surface }]}>
          {items.map((child, index) => (
            <Fragment key={isValidElement(child) && child.key !== null ? child.key : index}>
              {index > 0 ? <View style={[styles.divider, { backgroundColor: palette.separator }]} /> : null}
              {child}
            </Fragment>
          ))}
        </View>
      ) : null}
      {footer ? <Text style={[styles.sectionFooter, { color: palette.muted }]}>{footer}</Text> : null}
    </View>
  );
}

/** A row in a Section. Without `onPress` it is plain content. Read as one phrase by screen readers. */
export function Row({
  leading,
  title,
  titleMono = false,
  subtitle,
  subtitleMono = false,
  detail,
  trailing,
  chevron = false,
  onPress,
  disabled = false,
  tone = "default",
  accessibilityLabel,
  accessibilityHint,
}: {
  leading?: ReactNode;
  title: string;
  titleMono?: boolean;
  subtitle?: string | undefined;
  subtitleMono?: boolean;
  detail?: string | undefined;
  trailing?: ReactNode;
  chevron?: boolean;
  onPress?: (() => void) | undefined;
  disabled?: boolean;
  tone?: "default" | "danger" | "muted";
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const palette = usePalette();
  const titleColor = tone === "danger" ? palette.tones.red.ink : tone === "muted" ? palette.muted : palette.text;
  const content = (
    <>
      {leading ? <View style={styles.rowLeading}>{leading}</View> : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: titleColor }, titleMono ? styles.mono : null]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.meta, { color: palette.muted }, subtitleMono ? styles.mono : null]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {detail ? (
          <Text style={[styles.footnote, { color: palette.muted }]} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon name="chevronRight" size={18} color={palette.dim} /> : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.row} accessible accessibilityLabel={accessibilityLabel ?? spoken(title, subtitle, detail)}>
        {content}
      </View>
    );
  }
  return (
    <Tappable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? spoken(title, subtitle, detail)}
      accessibilityState={{ disabled }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      disabled={disabled}
      onPress={onPress}
      focusRadius={0}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? palette.raised : "transparent", opacity: disabled ? 0.45 : 1 },
      ]}
    >
      {content}
    </Tappable>
  );
}

function spoken(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(", ");
}

/** One option of a single choice inside a Section. The picked one carries an accent check. */
export function ChoiceRow({
  label,
  description,
  leading,
  checked,
  onPress,
  disabled = false,
  labelMono = false,
}: {
  label: string;
  description?: string | undefined;
  leading?: ReactNode;
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
      focusRadius={0}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? palette.raised : "transparent", opacity: disabled ? 0.45 : 1 },
      ]}
    >
      {leading ? <View style={styles.rowLeading}>{leading}</View> : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: palette.text }, labelMono ? styles.mono : null]} numberOfLines={1}>
          {label}
        </Text>
        {description ? <Text style={[styles.footnote, { color: palette.muted }]}>{description}</Text> : null}
      </View>
      <View style={styles.check}>
        {checked ? <Icon name="check" size={20} color={palette.accent} strokeWidth={2.25} /> : null}
      </View>
    </Tappable>
  );
}

/** Two or three options side by side. The picked one gets a neutral raised fill, as on the desktop. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const palette = usePalette();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.segmented, { backgroundColor: palette.well }]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Tappable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: option.disabled === true }}
            accessibilityLabel={option.label}
            disabled={option.disabled}
            onPress={() => onChange(option.value)}
            focusRadius={radius.sm}
            style={[
              styles.segment,
              { backgroundColor: selected ? palette.overlay : "transparent", opacity: option.disabled ? 0.45 : 1 },
            ]}
          >
            <Text style={[styles.segmentLabel, { color: selected ? palette.text : palette.muted }]} numberOfLines={1}>
              {option.label}
            </Text>
          </Tappable>
        );
      })}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
  busy = false,
}: {
  icon?: IconName;
  title: string;
  message?: string | undefined;
  action?: { label: string; onPress: () => void; variant?: ButtonVariant } | undefined;
  busy?: boolean;
}) {
  const palette = usePalette();
  return (
    <View style={styles.empty} accessibilityLiveRegion="polite">
      {busy ? (
        <ActivityIndicator color={palette.muted} accessibilityLabel={title} />
      ) : icon ? (
        <Icon name={icon} size={28} color={palette.dim} strokeWidth={1.5} />
      ) : null}
      <Text style={[styles.emptyTitle, { color: palette.text }]}>{title}</Text>
      {message ? <Text style={[styles.emptyMessage, { color: palette.muted }]}>{message}</Text> : null}
      {action ? (
        <View style={styles.emptyAction}>
          <Button label={action.label} onPress={action.onPress} variant={action.variant ?? "secondary"} />
        </View>
      ) : null}
    </View>
  );
}

/** An island with its own content, such as a request card. */
export function Card({
  children,
  edge,
  style,
}: {
  children: ReactNode;
  /** A state color for the edge, such as amber while an agent waits on the person. */
  edge?: string | undefined;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: palette.surface, borderColor: edge ?? "transparent", borderWidth: edge ? 1 : 0 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => subscription.remove();
  }, []);
  return reduced;
}

/** Characters past this many end in an ellipsis, since each one is laid out on its own. */
const SHIMMER_MAX = 44;
const SHIMMER_BAND = 0.18;

/**
 * The desktop's shimmer-text: muted text with a lighter band sweeping across it while work runs. Each
 * character fades on the native thread, because React Native cannot clip a gradient to text without a
 * mask. With reduced motion it is plain muted text.
 */
export function ShimmerText({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const palette = usePalette();
  const reduced = useReducedMotion();
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) return;
    sweep.setValue(0);
    const loop = Animated.loop(
      Animated.timing(sweep, { toValue: 1, duration: 2200, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, sweep]);

  const shown = text.length > SHIMMER_MAX ? `${text.slice(0, SHIMMER_MAX - 1).trimEnd()}…` : text;
  if (reduced) {
    return (
      <Text style={[style, { color: palette.muted }]} numberOfLines={1}>
        {shown}
      </Text>
    );
  }
  const chars = Array.from(shown);
  const span = 1 - 2 * SHIMMER_BAND;
  return (
    <View style={styles.shimmer} accessible accessibilityRole="text" accessibilityLabel={text}>
      {chars.map((char, index) => {
        const at = SHIMMER_BAND + (index / Math.max(1, chars.length - 1)) * span;
        const opacity = sweep.interpolate({
          inputRange: [at - SHIMMER_BAND, at, at + SHIMMER_BAND],
          outputRange: [0.62, 1, 0.62],
          extrapolate: "clamp",
        });
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: characters repeat, and their order never changes.
          <Animated.Text key={index} style={[style, { color: palette.text, opacity }]}>
            {char}
          </Animated.Text>
        );
      })}
    </View>
  );
}

/**
 * The desktop's stop control: a small square inside a ring. The ring turns in the Working blue while
 * the agent works, speeds up after a press until the work has ended, and stays still for an idle
 * agent. Pressing turns it red. With reduced motion it keeps turning, slowly, because it carries meaning.
 */
export function StopButton({
  label,
  running,
  stopping,
  disabled = false,
  onPress,
}: {
  label: string;
  running: boolean;
  stopping: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  const reduced = useReducedMotion();
  const spin = useRef(new Animated.Value(0)).current;
  const turning = running || stopping;

  useEffect(() => {
    if (!turning) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const duration = (stopping ? 450 : 1400) * (reduced ? 3 : 1);
    spin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [turning, stopping, reduced, spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Tappable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || stopping, busy: stopping }}
      disabled={disabled || stopping}
      onPress={onPress}
      hitSlop={4}
      focusRadius={TAP / 2}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: pressed ? palette.overlay : palette.raised, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      {({ pressed }) => {
        const ring = pressed ? palette.tones.red.ink : turning ? palette.tones.blue.ink : palette.dim;
        const square = pressed ? palette.tones.red.ink : palette.text;
        return (
          <>
            <Animated.View style={{ transform: [{ rotate }] }}>
              <Svg width={24} height={24} viewBox="0 0 24 24">
                <Circle
                  cx="12"
                  cy="12"
                  r="10"
                  fill="none"
                  stroke={ring}
                  strokeWidth={2}
                  strokeLinecap="round"
                  {...(turning ? { strokeDasharray: "44 19" } : {})}
                />
              </Svg>
            </Animated.View>
            <View style={styles.stopSquare} pointerEvents="none">
              <Svg width={8} height={8} viewBox="0 0 8 8">
                <Rect width="8" height="8" rx="1.5" fill={square} />
              </Svg>
            </View>
          </>
        );
      }}
    </Tappable>
  );
}

export const styles = StyleSheet.create({
  focusRing: { position: "absolute", top: -3, left: -3, right: -3, bottom: -3, borderWidth: 2, pointerEvents: "none" },
  grow: { flexGrow: 1, flexBasis: 0 },
  mono: { fontFamily: mono },
  meta: { ...type.meta },
  footnote: { ...type.footnote },
  button: {
    minHeight: TAP,
    minWidth: TAP,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  buttonLarge: { minHeight: 52, paddingHorizontal: space.xl },
  buttonLabel: { ...type.body, fontWeight: "600" },
  shimmer: { flexDirection: "row", flexShrink: 1, minWidth: 0, overflow: "hidden" },
  iconButton: {
    width: TAP,
    height: TAP,
    borderRadius: TAP / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
  },
  largeHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  headerLeading: { paddingLeft: space.xs, paddingRight: space.xxs },
  headerText: { flex: 1, minHeight: TAP, justifyContent: "center", gap: 1, paddingHorizontal: space.xs },
  headerTitle: { ...type.headline, fontWeight: "600" },
  largeTitle: { ...type.largeTitle, fontWeight: "700", letterSpacing: -0.4 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  status: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusLabel: { ...type.meta, fontWeight: "600" },
  notice: {
    flexDirection: "row",
    gap: space.md,
    padding: space.md,
    paddingRight: space.lg,
    borderRadius: radius.md,
  },
  noticeIcon: { paddingTop: 1 },
  noticeText: { flex: 1, gap: 2 },
  noticeTitle: { ...type.footnote, fontWeight: "600" },
  noticeAction: { flexDirection: "row", marginTop: space.sm },
  field: { gap: space.xs + 2 },
  fieldLabel: { ...type.meta, fontWeight: "600", paddingHorizontal: space.xs },
  fieldNote: { ...type.meta, paddingHorizontal: space.xs },
  input: {
    minHeight: 48,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    ...type.body,
  },
  inputMono: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
  section: { gap: space.sm },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    minHeight: 28,
    paddingHorizontal: space.xs,
  },
  sectionTitle: { flex: 1, ...type.footnote, fontWeight: "600" },
  sectionFooter: { ...type.meta, paddingHorizontal: space.xs },
  island: { borderRadius: radius.island, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  rowLeading: { width: 24, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { ...type.body, fontWeight: "500" },
  check: { width: 24, alignItems: "center" },
  segmented: { flexDirection: "row", padding: 3, borderRadius: radius.md, gap: 3 },
  segment: {
    flex: 1,
    minHeight: TAP - 2,
    borderRadius: radius.sm + 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  segmentLabel: { ...type.footnote, fontWeight: "600" },
  empty: { alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.xl, flexGrow: 1 },
  emptyTitle: { ...type.headline, fontWeight: "600", textAlign: "center", marginTop: space.xs },
  emptyMessage: { ...type.footnote, textAlign: "center", maxWidth: 320 },
  emptyAction: { marginTop: space.md },
  card: { borderRadius: radius.island, padding: space.lg, gap: space.md },
  stopSquare: { position: "absolute", alignItems: "center", justifyContent: "center" },
});
