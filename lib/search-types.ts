export type SearchHit = {
  id: string;
  category: "patient" | "exercise" | "condition" | "booking" | "shortcut";
  label: string;
  sublabel?: string;
  href: string;
};
