/* Read-only diagnostic preview for the inspected ERP snapshot.
   Results contain customer personal data; keep them local.
   This is a bounded preview, NOT a complete incremental sync query.
   Confirm live sale-finalization semantics before enabling invoice-triggered actions.
   Do not assume posted=1 or fclosed=1: both were zero throughout the snapshot.
   The program and operational branch allowlist match scripts/read_customers.sql.
   No ERP writes and no WhatsApp actions are performed. */
SET NOCOUNT ON;
DECLARE @ProgramItemsId bigint = 9;
DECLARE @PreviewLimit int = 200;

SELECT TOP (@PreviewLimit)
       i.idprogramitems,
       i.idbranch,
       i.idno_s,
       i.fno_i,
       i.fdate,
       i.dateentry,
       i.idperson,
       p.fperson,
       p.ftel1,
       p.ftel2,
       p.ftel3,
       p.ftel4,
       bm.fbranch,
       i.posted,
       i.fclosed,
       i.fnew,
       i.deleted
FROM dbo.invo_s i
JOIN dbo.person p
  ON p.idprogramitems = i.idprogramitems
 AND p.idbranch = i.idbranch
 AND p.idperson = i.idperson
JOIN dbo.kindperson k
  ON k.idprogramitems = p.idprogramitems
 AND k.idbranch = p.idbranch
 AND k.idkindperson = p.idkindperson
JOIN dbo.branch b
  ON b.idprogramitems = i.idprogramitems
 AND b.idbranch = i.idbranch
JOIN dbo.branchmain bm
  ON bm.idbranch = i.idbranch
WHERE i.idprogramitems = @ProgramItemsId
  AND i.idbranch IN (39, 40, 41, 42, 45, 51, 56, 57, 60)
  AND COALESCE(i.deleted, 0) = 0
  AND LTRIM(RTRIM(k.fkindperson)) = N'عميل'
  AND COALESCE(p.fhid, 0) = 0
  AND COALESCE(b.deleted, 0) = 0
  AND COALESCE(bm.deleted, 0) = 0
  AND b.fvis = 1
  AND bm.fvis = 1
ORDER BY i.dateentry DESC, i.idbranch, i.idno_s DESC;
