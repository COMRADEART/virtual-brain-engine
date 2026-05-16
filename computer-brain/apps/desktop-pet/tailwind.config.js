/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#02070a",
        panel: "#071417",
        cyan: "#5df2ff",
        mint: "#83ffb0",
        amber: "#ffcf5a",
        danger: "#ff5d7a"
      },
      fontFamily: {
        mono: ["Bahnschrift", "Cascadia Mono", "ui-monospace", "monospace"]
      }
    }
  },
  plugins: []
};
