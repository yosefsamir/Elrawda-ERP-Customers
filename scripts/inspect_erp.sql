/* Read-only discovery. Run in the ERP database, preferably on a restored copy.
   Does not export customer names, telephone numbers, or credentials. */
SET NOCOUNT ON;

SELECT DB_NAME() AS database_name,
       DATABASEPROPERTYEX(DB_NAME(), 'Version') AS internal_database_version,
       compatibility_level, is_read_only, is_cdc_enabled
FROM sys.databases WHERE database_id = DB_ID();

SELECT s.name AS schema_name, t.name AS table_name, SUM(p.rows) AS approximate_rows
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name
ORDER BY t.name;

SELECT s.name AS schema_name, t.name AS table_name, c.column_id, c.name AS column_name,
       ty.name AS type_name, c.max_length, c.is_nullable, c.is_identity,
       c.is_computed, dc.definition AS default_definition
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
WHERE t.name IN ('person', 'kindperson', 'groupperson', 'branch', 'branchmain', 'programitems')
ORDER BY t.name, c.column_id;

SELECT fk.name AS constraint_name,
       OBJECT_SCHEMA_NAME(fk.parent_object_id) AS parent_schema,
       OBJECT_NAME(fk.parent_object_id) AS parent_table,
       COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS parent_column,
       OBJECT_NAME(fk.referenced_object_id) AS referenced_table,
       COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS referenced_column
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
WHERE OBJECT_NAME(fk.parent_object_id) IN ('person', 'personcust', 'branch', 'branchmain')
   OR OBJECT_NAME(fk.referenced_object_id) IN ('person', 'personcust', 'branch', 'branchmain')
ORDER BY parent_table, constraint_name;

SELECT OBJECT_NAME(i.object_id) AS table_name, i.name AS index_name,
       i.is_primary_key, i.is_unique, ic.key_ordinal, c.name AS column_name
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE OBJECT_NAME(i.object_id) IN ('person', 'personcust', 'branch', 'branchmain')
ORDER BY table_name, index_name, ic.key_ordinal;

SELECT OBJECT_NAME(object_id) AS table_name, is_track_columns_updated_on,
       begin_version, min_valid_version
FROM sys.change_tracking_tables;
