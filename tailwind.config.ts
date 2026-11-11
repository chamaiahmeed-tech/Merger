import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-cairo)", "Tajawal", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
