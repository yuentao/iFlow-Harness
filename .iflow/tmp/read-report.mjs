import fs from "node:fs";
const j = JSON.parse(fs.readFileSync(".iflow/tmp/board-verify.json", "utf8"));
const pick = (x) => x && { edge: x.edge, min: x.min, max: x.max, sd: x.sd, mean: x.mean, rows: x.rows && x.rows.slice(0, 8) };
const e = j.atoms.expanded;
const c = j.atoms.collapsed;
console.log(
  JSON.stringify(
    {
      loaded: j.meta.loaded,
      page: j.meta.page,
      dist: j.meta.dist,
      expanded: e && {
        bf: e.backdropFilter,
        bg: e.backgroundColor,
        alpha: e.backgroundAlpha,
        bgi: (e.backgroundImage || "").slice(0, 90),
        shadow: e.boxShadow,
        rect: e.rect,
        nonVisibleAncestors: e.ancestors.filter((a) => a.overflow !== "visible"),
        backdropAncestors: e.ancestors.filter((a) => a.backdropFilter && a.backdropFilter !== "none"),
        textUnder: e.textUnderBoard,
        docScrollWidth: e.docScrollWidth,
        innerWidth: e.innerWidth,
      },
      expandedShadowBand: j.atoms.expandedShadowBand,
      expandedFarBand: j.atoms.expandedShadowFarBand,
      expandedBelow: pick(j.atoms.expandedBelowRows),
      collapsed: c && { rect: c.rect, shadow: c.boxShadow, textUnder: c.textUnderBoard, alpha: c.backgroundAlpha, bf: c.backdropFilter },
      collapsedShadowBand: j.atoms.collapsedShadowBand,
      collapsedBelow: pick(j.atoms.collapsedBelowRows),
      ghost: j.atoms.ghost && {
        chars: j.atoms.ghost.textCharsUnderShelf,
        withAcrylic: pick(j.atoms.ghost.withAcrylic),
        withoutAcrylic: pick(j.atoms.ghost.withoutAcrylic),
      },
      scrollPick: j.atoms.scrollPick,
      narrow: j.atoms.narrow,
      modal: j.atoms.modal,
      dark: j.atoms.dark && {
        bf: j.atoms.dark.backdropFilter,
        bg: j.atoms.dark.backgroundColor,
        alpha: j.atoms.dark.backgroundAlpha,
        shadow: j.atoms.dark.boxShadow,
        rect: j.atoms.dark.rect,
      },
      darkShadowBand: j.atoms.darkShadowBand,
      darkExpanded: j.atoms.darkExpanded && { rect: j.atoms.darkExpanded.rect, shadow: j.atoms.darkExpanded.boxShadow, alpha: j.atoms.darkExpanded.backgroundAlpha },
    },
    null,
    1,
  ),
);
