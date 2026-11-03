/* Read-only index inspection. This script creates or changes nothing in ERP.
   TOP (50) bounds returned headers, not SQL Server's internal logical reads.
   Review actual execution plans / STATISTICS IO on the customer's database.
   A matching index for the timestamp cursor, if approved by the ERP owner:

   CREATE NONCLUSTERED INDEX IX_invo_s_invoice_sync
   ON dbo.invo_s(idprogramitems,dateentry,idbranch,idno_s)
   INCLUDE(idperson,fno_i,fdate,fprinted,deleted);

   The DDL above is a review proposal only and is intentionally commented out.
*/
SET NOCOUNT ON;
SELECT ix.name AS index_name,ix.is_disabled,ic.key_ordinal,
       ic.is_included_column,col.name AS column_name
FROM sys.indexes ix
JOIN sys.index_columns ic ON ic.object_id=ix.object_id AND ic.index_id=ix.index_id
JOIN sys.columns col ON col.object_id=ic.object_id AND col.column_id=ic.column_id
WHERE ix.object_id=OBJECT_ID(N'dbo.invo_s')
ORDER BY ix.name,ic.is_included_column,ic.key_ordinal,ic.index_column_id;
