export const colours: { name: string; code: string }[] = [
  { name: "Teal", code: "#0d9488" },
  { name: "Green", code: "#65a30d" },
  { name: "Blue", code: "#0284c7" },
  { name: "Purple", code: "#4f46e5" },
  { name: "Yellow", code: "#ca8a04" },
  { name: "Orange", code: "#ea580c" },
  { name: "Red", code: "#dc2626" },
  { name: "Pink", code: "#db2777" },
] as const;

export type Colour = (typeof colours)[number];
