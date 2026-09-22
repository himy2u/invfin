// Shared design tokens — one place for color/spacing/radius/shadow/type decisions instead of each
// screen inventing its own hex values and paddings, which is how the app ended up looking like an
// unstyled 1990s form (every screen technically worked, but nothing shared a visual language).
import { Platform } from "react-native";

export const colors = {
  brand: "#0f766e",
  brandDark: "#115e59",
  brandLight: "#f0fdfa",
  brandBorder: "#5eead4",

  warning: "#b45309",
  warningLight: "#fffbeb",
  warningBorder: "#fde68a",

  danger: "#dc2626",
  dangerLight: "#fef2f2",

  success: "#059669",
  successLight: "#ecfdf5",

  background: "#f7f7f8",
  surface: "#ffffff",
  surfaceAlt: "#fafafa",
  border: "#e4e4e7",
  borderStrong: "#d4d4d8",

  textPrimary: "#18181b",
  textSecondary: "#52525b",
  textMuted: "#a1a1aa",
  textOnBrand: "#ffffff",

  // Only used on web, as the neutral area surrounding the phone-width content column.
  webSurround: "#e7e5e4",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

export const typography = {
  title: { fontSize: 22, fontWeight: "700" as const, color: colors.textPrimary },
  sectionTitle: { fontSize: 15, fontWeight: "700" as const, color: colors.textPrimary },
  body: { fontSize: 15, color: colors.textPrimary },
  label: { fontSize: 13, fontWeight: "600" as const, color: colors.textSecondary },
  caption: { fontSize: 12, color: colors.textMuted },
};

// A soft card elevation — react-native-web maps shadow* props to a CSS box-shadow, and Android
// needs `elevation` instead of shadow* to render anything, so both are provided together.
export const cardShadow = Platform.select({
  web: { boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 1px 8px rgba(0,0,0,0.06)" },
  default: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
}) as object;

export const card = {
  backgroundColor: colors.surface,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: colors.border,
  padding: spacing.lg,
  ...cardShadow,
};

export const input = {
  borderWidth: 1,
  borderColor: colors.borderStrong,
  borderRadius: radius.sm,
  paddingVertical: 11,
  paddingHorizontal: spacing.md,
  fontSize: 15,
  color: colors.textPrimary,
  backgroundColor: colors.surface,
};

export const primaryButton = {
  backgroundColor: colors.brand,
  borderRadius: radius.sm,
  paddingVertical: 14,
  alignItems: "center" as const,
  ...cardShadow,
};
