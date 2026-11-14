import type { ItemPerformanceSummary } from "../../shared/api/reports";

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

type Props = {
  summary: ItemPerformanceSummary;
  from: string;
  to: string;
  periodDays: number;
};

export function ItemPerformanceSummaryCards({ summary, from, to, periodDays }: Props) {
  const cards = [
    { label: "كمية البيع", value: fmt.format(summary.totalSold), hint: "إجمالي المبيعات" },
    { label: "مرتجع البيع", value: fmt.format(summary.totalReturnSold), hint: "المرتجع خلال الفترة" },
    { label: "صافي المباع", value: fmt.format(summary.totalNetSold), hint: "البيع ناقص المرتجع", accent: true },
    { label: "المتبقي بنهاية الفترة", value: fmt.format(summary.totalClosing), hint: `حتى ${to} (ليس رصيد اليوم)` },
    { label: "الأصناف المطابقة", value: fmt.format(summary.uniqueProductCount), hint: `${fmt.format(summary.rowCount)} سطر مخزني` },
    { label: "أصناف بلا بيع", value: fmt.format(summary.zeroSalesCount), hint: `خلال ${periodDays} يوم (${from})` },
  ];

  return (
    <section className="ip-summary-section" aria-label="ملخص أداء الأصناف">
      <div className="ip-summary-grid">
        {cards.map(card => (
          <div key={card.label} className={`ip-summary-card ${card.accent ? "is-accent" : ""}`}>
            <span className="ip-summary-label">{card.label}</span>
            <strong className="ip-summary-value">{card.value}</strong>
            <span className="ip-summary-hint">{card.hint}</span>
          </div>
        ))}
      </div>
      <p className="ip-period-note">
        الرصيد المتبقي المعروض يمثل نهاية الفترة المحددة ({to}) وليس رصيد اليوم الحالي.
        {summary.negativeClosingCount > 0 && ` تم تصفير ${fmt.format(summary.negativeClosingCount)} حالة ذات رصيد سالب في العرض.`}
      </p>
    </section>
  );
}
