/* Read-only discovery on an ERP copy. No customer data or stored-procedure execution.
   Dates below target the supplied October snapshot; change for a different source.
   Results are diagnostic evidence, not approved accounting/stock totals. */
SET NOCOUNT ON;
SET LOCK_TIMEOUT 5000;
DECLARE @program bigint = 9, @from datetime = '20261001', @until datetime = '20261028';

SELECT DB_NAME() source_database, MIN(fdate) first_invoice, MAX(fdate) last_invoice,
       COUNT_BIG(*) invoice_headers
FROM dbo.invo_s WHERE idprogramitems=@program;

-- Header key must include program + branch + invoice, never invoice number alone.
SELECT 'sales' movement, COUNT_BIG(*) detail_rows,
       SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_header,
       SUM(CASE WHEN d.deleted IS NULL THEN 1 ELSE 0 END) null_detail_deleted,
       SUM(CASE WHEN h.deleted IS NULL THEN 1 ELSE 0 END) null_header_deleted
FROM dbo.sadr d LEFT JOIN dbo.invo_s h
  ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'returns', COUNT_BIG(*),
       SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END),
       SUM(CASE WHEN d.deleted IS NULL THEN 1 ELSE 0 END),
       SUM(CASE WHEN h.deleted IS NULL THEN 1 ELSE 0 END)
FROM dbo.return_s d LEFT JOIN dbo.invo_return_s h
  ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program;

-- Check dimensions with LEFT JOIN so absent definitions are visible.
SELECT COUNT_BIG(*) active_sales_lines,
       SUM(CASE WHEN d0.iddet IS NULL THEN 1 ELSE 0 END) missing_product,
       SUM(CASE WHEN k.idkind IS NULL THEN 1 ELSE 0 END) missing_classification,
       SUM(CASE WHEN u.iddet IS NULL THEN 1 ELSE 0 END) missing_unit,
       SUM(CASE WHEN st.idstor IS NULL THEN 1 ELSE 0 END) missing_store,
       SUM(CASE WHEN bm.idbranch IS NULL THEN 1 ELSE 0 END) missing_branch
FROM dbo.sadr d JOIN dbo.invo_s h
  ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
LEFT JOIN dbo.maindet d0 ON d0.iddet=d.iddet
LEFT JOIN dbo.mainfarz f ON f.idfarz=d0.idfarz
LEFT JOIN dbo.mainsize s ON s.idsize=f.idsize
LEFT JOIN dbo.maincolor c ON c.idcolor=s.idcolor
LEFT JOIN dbo.main n ON n.idname=c.idname
LEFT JOIN dbo.kind k ON k.idkind=n.idkind AND k.idprogramitems=d.idprogramitems
LEFT JOIN dbo.mainunits u ON u.iddet=d.iddet AND u.idunit=d.idunit
LEFT JOIN dbo.stor st ON st.idprogramitems=d.idprogramitems AND st.idbranch=d.idbranch AND st.idstor=d.idstor
LEFT JOIN dbo.branchmain bm ON bm.idbranch=d.idbranch
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0;

-- Keep sale and return quantities separate; units are not silently combined.
WITH movements AS (
 SELECT 'sales' movement,h.idbranch,h.fdate,d.idunit,d.fquntity,d.fbouns,d.fpr_s,d.fpr_sd
 FROM dbo.sadr d JOIN dbo.invo_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
 WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 UNION ALL
 SELECT 'returns',h.idbranch,h.fdate,d.idunit,d.fquntity,d.fbouns,d.fpr_s,d.fpr_sd
 FROM dbo.return_s d JOIN dbo.invo_return_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
 WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
)
SELECT movement,idbranch,idunit,COUNT_BIG(*) detail_rows,SUM(fquntity) raw_quantity,
 SUM(fbouns) raw_bonus,SUM(fquntity*fpr_s) candidate_line_value,
 SUM(CASE WHEN fpr_s<>fpr_sd THEN 1 ELSE 0 END) different_price_lines,
 SUM(CASE WHEN fquntity<0 THEN 1 ELSE 0 END) negative_quantity_lines
FROM movements WHERE fdate>=@from AND fdate<@until
GROUP BY movement,idbranch,idunit ORDER BY movement,idbranch,idunit;

-- famount is intentionally compared, not declared to be invoice sales value.
WITH lines AS (
 SELECT d.idprogramitems,d.idbranch,d.idno_s,SUM(d.fquntity*d.fpr_s) line_value
 FROM dbo.sadr d WHERE d.idprogramitems=@program AND d.deleted=0
 GROUP BY d.idprogramitems,d.idbranch,d.idno_s
)
SELECT COUNT_BIG(*) active_headers,
 SUM(CASE WHEN l.idno_s IS NULL THEN 1 ELSE 0 END) without_active_lines,
 SUM(CASE WHEN ABS(l.line_value-h.famount)>0.01 THEN 1 ELSE 0 END) value_differs_from_famount,
 SUM(CASE WHEN h.fdiscount<>0 OR h.fdiscountover<>0 THEN 1 ELSE 0 END) header_discount_invoices,
 SUM(CASE WHEN h.ftax<>0 THEN 1 ELSE 0 END) header_tax_invoices,
 SUM(CASE WHEN h.fdelivery<>0 OR h.fmoto<>0 THEN 1 ELSE 0 END) header_other_charge_invoices,
 SUM(CASE WHEN h.famountvisa<>0 THEN 1 ELSE 0 END) visa_invoices,
 SUM(CASE WHEN h.posted=1 THEN 1 ELSE 0 END) posted_invoices
FROM dbo.invo_s h LEFT JOIN lines l
 ON l.idprogramitems=h.idprogramitems AND l.idbranch=h.idbranch AND l.idno_s=h.idno_s
WHERE h.idprogramitems=@program AND h.deleted=0 AND h.fdate>=@from AND h.fdate<@until;

-- Example hierarchy for the previously confirmed code; labels follow the screenshot.
SELECT d.iddet,k.idkind,k.fkind AS item_type,n.idname,n.fname AS item_section,
 c.idcolor,c.fcolor AS item_classification,s.idsize,s.fsize AS item_size,
 f.idfarz,f.ffarz AS item_code,u.idunit,u.funit
FROM dbo.maindet d
JOIN dbo.mainfarz f ON f.idfarz=d.idfarz
JOIN dbo.mainsize s ON s.idsize=f.idsize
JOIN dbo.maincolor c ON c.idcolor=s.idcolor
JOIN dbo.main n ON n.idname=c.idname
JOIN dbo.kind k ON k.idkind=n.idkind AND k.idprogramitems=@program
JOIN dbo.mainunits u ON u.iddet=d.iddet
WHERE f.ffarz='Z3330';

SELECT d.idunit,COUNT_BIG(*) active_lines,
 SUM(CASE WHEN d.fbouns<>0 THEN 1 ELSE 0 END) bonus_lines,
 SUM(CASE WHEN d.fpr_items<>0 THEN 1 ELSE 0 END) component_price_lines
FROM dbo.sadr d JOIN dbo.invo_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
GROUP BY d.idunit;
