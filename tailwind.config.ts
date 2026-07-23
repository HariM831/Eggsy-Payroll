import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#7A1224",
          dark: "#5A0D1A",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
