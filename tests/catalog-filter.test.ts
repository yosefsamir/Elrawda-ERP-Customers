import assert from "node:assert/strict";
import test from "node:test";
import { addScope, ancestors, buildCatalogIndex, cairoDate, changeBranches, defaultFilterValue, selectedLeaves, storeOptions, toggleCatalogNode, validateFilter, type CatalogNode, type LocationOption } from "../apps/reports/src/components/catalog-filter/model.js";
import { groupItemPerformanceRows } from "../apps/reports/src/features/item-performance/grouping.js";
import type { ItemPerformanceRow } from "../apps/reports/src/shared/api/reports.js";
const nodes: CatalogNode[] = [
  {id:"clothes",parentId:null,level:"type",label:"ملابس"},
  {id:"pants",parentId:"clothes",level:"section",label:"بنطلون"},
  {id:"jeans",parentId:"pants",level:"product",label:"جينز"},
  {id:"cotton",parentId:"pants",level:"product",label:"قطن"},
  {id:"shirt",parentId:"clothes",level:"product",label:"قميص"},
  {id:"shoes",parentId:null,level:"type",label:"أحذية"},
  {id:"shoe",parentId:"shoes",level:"product",label:"رياضي"},
];
const index=buildCatalogIndex(nodes), all={mode:"all" as const,includeIds:[],excludeIds:[]};
const ids=(selection:typeof all|ReturnType<typeof toggleCatalogNode>)=>selectedLeaves(index,selection).map(n=>n.id).sort();
const locations:LocationOption[]=[{id:"a",label:"A",stores:[{id:"1",label:"A1"}]},{id:"b",label:"B",stores:[{id:"1",label:"B1"}]}];
test("arbitrary-level selection resolves ancestors and includes each leaf once",()=>{
  assert.deepEqual(ancestors(index,"jeans").map(n=>n.id),["clothes","pants","jeans"]);
  assert.deepEqual(ids({mode:"selected",includeIds:["clothes","pants","jeans"],excludeIds:[]}),["cotton","jeans","shirt"]);
});
test("deselecting one child of an included parent preserves siblings and partial selection",()=>{
  const next=toggleCatalogNode(index,all,"jeans");
  assert.deepEqual(ids(next),["cotton","shirt","shoe"]);
  assert.deepEqual(ids(toggleCatalogNode(index,next,"jeans")),ids(all));
});
test("explicit exclusions win, and selecting none resets to all",()=>{
  assert.deepEqual(ids({...all,excludeIds:["pants"]}),["shirt","shoe"]);
  let selection=toggleCatalogNode(index,all,"clothes");selection=toggleCatalogNode(index,selection,"shoes");
  assert.equal(selection.mode,"all");assert.deepEqual(ids(selection),["cotton","jeans","shirt","shoe"]);
});
test("cascade replaces the active scope; additional independent paths survive",()=>{
  const clothes=addScope(index,all,"clothes");
  const pants=addScope(index,clothes,"pants","clothes");assert.deepEqual(ids(pants),["cotton","jeans"]);
  const plusShoes=addScope(index,pants,"shoes");
  assert.deepEqual(ids(addScope(index,plusShoes,"shirt","shoes")),["cotton","jeans","shirt"]);
});
test("stores are branch-scoped; removing a branch prunes its stores without selecting all",()=>{
  const initial={...defaultFilterValue("2026-11-13"),stores:{mode:"selected" as const,ids:["a:1","b:1"]}};
  assert.deepEqual(storeOptions(locations,initial.branches).map(s=>s.id),["a:1","b:1"]);
  const next=changeBranches(initial,{mode:"selected",ids:["b"]},locations);
  assert.deepEqual(next.stores,{mode:"selected",ids:["b:1"]});
  assert.deepEqual(changeBranches(next,{mode:"selected",ids:[]},locations).stores,{mode:"selected",ids:["b:1"]});
});
test("dates, empty scopes and stale ids are validated before applying",()=>{
  const value=defaultFilterValue("2026-11-13");assert.equal(validateFilter(value,index,locations),null);
  assert.match(validateFilter({...value,from:"2026-12-01"},index,locations)!,/البداية/);
  assert.match(validateFilter({...value,through:"2026-02-30"},index,locations)!,/صحيحين/);
  assert.equal(validateFilter({...value,items:{mode:"selected",includeIds:[],excludeIds:[]}},index,locations),null);
  assert.equal(validateFilter({...value,branches:{mode:"selected",ids:[]}},index,locations),null);
  assert.match(validateFilter({...value,items:{mode:"selected",includeIds:["missing"],excludeIds:[]}},index,locations)!,/متاحة/);
});
test("malformed catalog inputs fail deterministically instead of looping",()=>{
  assert.throws(()=>buildCatalogIndex([...nodes,nodes[0]]),/Duplicate/);
  assert.throws(()=>buildCatalogIndex([{id:"a",parentId:"missing",level:"type",label:"A"}]),/Missing/);
  assert.throws(()=>buildCatalogIndex([{id:"a",parentId:"b",level:"type",label:"A"},{id:"b",parentId:"a",level:"section",label:"B"}]),/cycle/);
});
test("default dates use Cairo, even around UTC midnight",()=>{
  assert.equal(cairoDate(new Date("2026-11-12T23:30:00Z")),"2026-11-13");
});
test("groupItemPerformanceRows aggregates quantities per branch and recalculates rates from totals",()=>{
  const base:ItemPerformanceRow={programId:"1",branchId:"10",branchName:"فرع 1",storeId:"1",storeName:"رئيسي",productId:"101",code:"M1",itemType:"ملابس",section:"شتوي",classification:"هودي",description:"L",serviceItem:false,opening:10,rawOpening:10,inbound:0,transferIn:0,sold:5,returnSold:0,netSold:5,transferOut:0,otherMovements:0,closing:5,rawClosing:5,sellThroughPct:50,availableDays:10,periodDays:10,ratePerDay:0.5,coverDays:10,needsReview:false};
  const rows:ItemPerformanceRow[]=[
    base,
    {...base,storeId:"2",storeName:"مخزن 2",productId:"102",code:"M2",description:"XL",opening:10,rawOpening:10,sold:5,netSold:5,closing:5,rawClosing:5,availableDays:5},
    {...base,branchId:"20",branchName:"فرع 2",productId:"101",opening:4,rawOpening:4,sold:2,netSold:2,closing:2,rawClosing:2,availableDays:4},
  ];
  assert.equal(groupItemPerformanceRows(rows,null).length,3);
  const grouped=groupItemPerformanceRows(rows,"classification");
  assert.equal(grouped.length,2);
  const b1=grouped.find(r=>r.branchId==="10")!;
  assert.equal(b1.groupTitle,"هودي");
  assert.equal(b1.groupCount,2);
  assert.equal(b1.memberRows?.length,2);
  assert.equal(b1.storeName,"2 مخازن");
  assert.equal(b1.opening,20);
  assert.equal(b1.netSold,10);
  assert.equal(b1.closing,10);
  assert.equal(b1.sellThroughPct,50);
  assert.equal(b1.availableDays,10);
  assert.equal(b1.ratePerDay,1);
  assert.equal(b1.coverDays,10);
  const allBranches=groupItemPerformanceRows(rows,"classification",true);
  assert.equal(allBranches.length,1);
  assert.equal(allBranches[0].branchName,"إجمالي الفروع (2)");
  assert.equal(allBranches[0].netSold,12);
  assert.equal(allBranches[0].memberRows?.length,3);
  const byProductAcrossBranches=groupItemPerformanceRows(rows,null,true);
  assert.equal(byProductAcrossBranches.length,2);
});
