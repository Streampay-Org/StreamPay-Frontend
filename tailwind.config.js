/** @type {import('tailwindcss').Config} */
// Several components are written with Tailwind utility classes. Preflight is
// disabled so the hand-written design system in app/globals.css stays the base
// layer; Tailwind only contributes the utilities that are actually used.
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  // Dark is the default theme (see :root in globals.css); light mode is opt-in via html.light.
  darkMode: ["variant", "&:not(.light *)"],
  corePlugins: { preflight: false },
  theme: { extend: { boxShadow: { soft: "var(--shadow-soft)" } } },
  plugins: [],
};
