import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Onest", "Inter", "system-ui", "sans-serif"],
        display: ["Onest", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        sky: {
          50: "var(--sky-50)",
          100: "var(--sky-100)",
          200: "var(--sky-200)",
          300: "var(--sky-300)",
          400: "var(--sky-400)",
          500: "var(--sky-500)",
          600: "var(--sky-600)",
          700: "var(--sky-700)",
          800: "var(--sky-800)",
        },
        lime: {
          100: "var(--lime-100)",
          300: "var(--lime-300)",
          400: "var(--lime-400)",
          500: "var(--lime-500)",
        },
        navy: {
          100: "var(--navy-100)",
          200: "var(--navy-200)",
          300: "var(--navy-300)",
          500: "var(--navy-500)",
          700: "var(--navy-700)",
          900: "var(--navy-900)",
        },
        ink: "var(--navy-900)",
        muted: "var(--navy-500)",
      },
      borderRadius: {
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
        "2xl": "var(--r-2xl)",
      },
      backgroundImage: {
        "app-gradient": "var(--bg-app)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        "card-lg": "var(--shadow-card-lg)",
        glass: "var(--glass-shadow)",
      },
      letterSpacing: {
        display: "-0.025em",
      },
    },
  },
  plugins: [],
};

export default config;
