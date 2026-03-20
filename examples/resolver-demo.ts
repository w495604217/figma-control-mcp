/**
 * Practical resolver example — demonstrates Phase 2 selector capabilities.
 * Run with: npx tsx examples/resolver-demo.ts
 */
import { resolveBatchOperations } from "../src/batch-resolver.js";

const snapshot = {
  sessionId: "demo-session",
  pageName: "Landing Page",
  selectionIds: [],
  nodes: [
    { id: "hero", name: "Hero", type: "FRAME", parentId: "page-root", childIds: ["heading", "cta-btn", "icon-btn"], pluginData: {} },
    { id: "heading", name: "Title", type: "TEXT", parentId: "hero", childIds: [], pluginData: {} },
    { id: "cta-btn", name: "Button", type: "FRAME", parentId: "hero", childIds: ["btn-label"], pluginData: {} },
    { id: "icon-btn", name: "Button", type: "COMPONENT", parentId: "hero", childIds: [], pluginData: {} },
    { id: "btn-label", name: "Label", type: "TEXT", parentId: "cta-btn", childIds: [], pluginData: {} },
    { id: "footer", name: "Footer", type: "FRAME", parentId: "page-root", childIds: ["footer-label"], pluginData: {} },
    { id: "footer-label", name: "Label", type: "TEXT", parentId: "footer", childIds: [], pluginData: {} },
  ],
  variables: [],
  components: [],
};

console.log("=== Phase 2 Resolver Demo ===\n");

// 1. Basic name path (backwards compat)
const r1 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "Hero/Button[2]", patch: { name: "Icon" } },
]);
console.log("1. Name path Hero/Button[2]:");
console.log("   resolved →", r1.resolvedOperations[0]);
console.log("   errors:", r1.errors.length, "warnings:", r1.warnings.length);

// 2. Type-aware selector
const r2 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "Hero/Button:COMPONENT", patch: { name: "Typed" } },
]);
console.log("\n2. Type-aware Hero/Button:COMPONENT:");
console.log("   resolved →", r2.resolvedOperations[0]);
console.log("   warnings:", r2.warnings.length);

// 3. Case-insensitive type filter
const r3 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "Hero/Button:frame", patch: { name: "CaseInsensitive" } },
]);
console.log("\n3. Case-insensitive Hero/Button:frame:");
console.log("   resolved →", r3.resolvedOperations[0]);

// 4. Wildcard selector
const r4 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "Hero/*:TEXT", patch: { characters: "Wild" } },
]);
console.log("\n4. Wildcard Hero/*:TEXT:");
console.log("   resolved →", r4.resolvedOperations[0]);

// 5. Recursive descendant
const r5 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "Hero/**/Label", patch: { characters: "Deep" } },
]);
console.log("\n5. Recursive Hero/**/Label:");
console.log("   resolved →", r5.resolvedOperations[0]);

// 6. Ambiguous selector → warning
const r6 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "Hero/Button", patch: { name: "Ambiguous" } },
]);
console.log("\n6. Ambiguous Hero/Button (no index):");
console.log("   resolved →", r6.resolvedOperations[0]);
console.log("   warning →", r6.warnings[0]?.message);

// 7. #id:TYPE validation
const r7 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "#hero:FRAME", patch: { name: "Typed ID" } },
]);
console.log("\n7. #id:TYPE #hero:FRAME:");
console.log("   resolved →", r7.resolvedOperations[0]);

// 8. #id:TYPE mismatch
const r8 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "#hero:TEXT", patch: { name: "Wrong" } },
]);
console.log("\n8. #id:TYPE mismatch #hero:TEXT:");
console.log("   error →", r8.errors[0]?.message);

// 9. Resolution diagnostics
const r9 = resolveBatchOperations(snapshot, [
  { type: "update_node", nodePath: "Hero/Button", patch: { name: "Diag" } },
]);
console.log("\n9. Diagnostics for Hero/Button:");
console.log("   resolution →", JSON.stringify(r9.resolutions[0], null, 2));

console.log("\n=== Demo complete ===");
