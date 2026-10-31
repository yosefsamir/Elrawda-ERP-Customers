/* Read-only source query for the inspected ERP schema.
   Run against a restored copy first. Output contains customer personal data;
   keep results local. This query does not add anyone to WhatsApp.
   Program 9 is "Emoji Store" in the provided snapshot; verify on the live ERP.
   The nine operational branch IDs below were explicitly confirmed by the user.
   Keep this allowlist configurable when branches change.
   There is no created_at/updated_at/rowversion on dbo.person in this snapshot:
   comparing snapshots must detect both new composite keys and changed fields. */
SET NOCOUNT ON;
DECLARE @ProgramItemsId bigint = 9;

SELECT p.idprogramitems,
       p.idbranch,
       p.idperson,
       p.idkindperson,
       p.fperson,
       p.ftel1,
       p.ftel2,
       p.ftel3,
       p.ftel4,
       p.fhid,
       p.fglobal,
       bm.fbranch,
       k.fkindperson
FROM dbo.person p
JOIN dbo.kindperson k
  ON k.idprogramitems = p.idprogramitems
 AND k.idbranch = p.idbranch
 AND k.idkindperson = p.idkindperson
JOIN dbo.branch b
  ON b.idprogramitems = p.idprogramitems
 AND b.idbranch = p.idbranch
JOIN dbo.branchmain bm
  ON bm.idbranch = p.idbranch
WHERE p.idprogramitems = @ProgramItemsId
  AND p.idbranch IN (39, 40, 41, 42, 45, 51, 56, 57, 60)
  AND LTRIM(RTRIM(k.fkindperson)) = N'عميل'
  AND COALESCE(p.fhid, 0) = 0
  AND COALESCE(b.deleted, 0) = 0
  AND COALESCE(bm.deleted, 0) = 0
  AND b.fvis = 1
  AND bm.fvis = 1
ORDER BY p.idprogramitems, p.idbranch, p.idperson;
