import type { MachineFile } from "../../src/design/machines.js";
import { CHORES } from "../../src/spike/chores.js";

const files = import.meta.glob<MachineFile>("../../machines/*.json", { eager: true, import: "default" });

/** Every stored machine, in eval-set order. */
export const MACHINES: MachineFile[] = Object.values(files).sort((a, b) => CHORES.indexOf(a.chore) - CHORES.indexOf(b.chore));
