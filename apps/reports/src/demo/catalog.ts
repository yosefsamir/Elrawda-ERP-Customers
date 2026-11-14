import type { CatalogNode, LocationOption } from "../components/catalog-filter/model";
/** UI examples only. No ERP data, customer records, prices or stock quantities. */
const groups = [
  { type: "ملابس", sections: [
    { name: "بنطلون", classes: [ { name: "جينز", sizes: ["قصة مستقيمة", "قصة واسعة"] }, { name: "جبردين", sizes: ["جبردين مستورد", "جبردين كلاسيك"] }, { name: "ميلتون", sizes: ["ميلتون شتوي"] } ] },
    { name: "قميص", classes: [ { name: "كتان", sizes: ["كتان سادة", "كتان مخطط"] }, { name: "أكسفورد", sizes: ["أكسفورد كلاسيك"] } ] },
    { name: "تيشيرت", classes: [ { name: "قطن", sizes: ["قصة عادية", "أوفر سايز"] }, { name: "بولو", sizes: ["بولو سادة"] } ] },
  ] },
  { type: "أحذية", sections: [
    { name: "كوتشي", classes: [ { name: "رياضي", sizes: ["رياضي خفيف", "رياضي كلاسيك"] }, { name: "كاجوال", sizes: ["كاجوال يومي"] } ] },
    { name: "حذاء", classes: [ { name: "جلد", sizes: ["جلد رسمي", "جلد كاجوال"] } ] },
  ] },
  { type: "إكسسوارات", sections: [
    { name: "شنط", classes: [ { name: "كروس", sizes: ["شنطة صغيرة", "شنطة يومية"] }, { name: "ظهر", sizes: ["شنطة ظهر"] } ] },
    { name: "أحزمة", classes: [ { name: "جلد", sizes: ["حزام كلاسيك"] } ] },
  ] },
];
export const demoCatalog: CatalogNode[] = [];
let product = 100100;
for (const [ti, type] of groups.entries()) {
  const tid = `demo:type:${ti}`;
  demoCatalog.push({ id: tid, parentId: null, level: "type", label: type.type });
  for (const [si, section] of type.sections.entries()) {
    const sid = `${tid}:section:${si}`;
    demoCatalog.push({ id: sid, parentId: tid, level: "section", label: section.name });
    for (const [ci, classification] of section.classes.entries()) {
      const cid = `${sid}:class:${ci}`;
      demoCatalog.push({ id: cid, parentId: sid, level: "classification", label: classification.name });
      for (const [zi, size] of classification.sizes.entries()) {
        const zid = `${cid}:size:${zi}`;
        demoCatalog.push({ id: zid, parentId: cid, level: "size", label: size });
        for (let m = 1; m <= 2; m++) {
          const code = `${["D", "S", "A"][ti]}${1500 + si * 100 + ci * 20 + zi * 5 + m}`;
          const mid = `${zid}:model:${m}`;
          demoCatalog.push({ id: mid, parentId: zid, level: "model", label: code, code });
          product++;
          demoCatalog.push({ id: `${mid}:product`, parentId: mid, level: "product", label: String(product), code: String(product) });
        }
      }
    }
  }
}
export const demoLocations: LocationOption[] = [
  { id: "demo:main", label: "المركز الرئيسي", stores: [{ id: "main", label: "المخزن الرئيسي" }, { id: "season", label: "المخزن الموسمي" }] },
  { id: "demo:mansoura", label: "المنصورة", stores: [{ id: "main", label: "مخزن المنصورة" }] },
  { id: "demo:omar", label: "عمر أفندي", stores: [{ id: "main", label: "مخزن عمر أفندي" }] },
  { id: "demo:sherbin", label: "شربين", stores: [{ id: "main", label: "مخزن شربين" }] },
  { id: "demo:zarqa", label: "الزرقا", stores: [{ id: "main", label: "مخزن الزرقا" }] },
  { id: "demo:faraskour", label: "فارسكور", stores: [{ id: "main", label: "مخزن فارسكور" }] },
];
