# Reusable catalog filter

Controlled React component for an RTL hierarchy, date interval, branches and stores. It performs **no fetches**, reads no ERP connection and knows nothing about reports, authentication or the preview fixture.

```tsx
import { CatalogFilter, defaultFilterValue } from "./components/catalog-filter";
import type { CatalogFilterValue } from "./components/catalog-filter";

const [filter, setFilter] = useState<CatalogFilterValue>(() => defaultFilterValue());

<CatalogFilter
  nodes={catalogNodes}
  locations={branchesWithStores}
  value={filter}
  onChange={setFilter}
  onApply={validatedFilter => consumeFilter(validatedFilter)}
  loading={loading}
  error={errorMessage}
  onRetry={reloadOptions}
/>
```

- Supply a stable array of `CatalogNode` objects with unique **source-scoped string IDs**, explicit `parentId`, `level` and `label`. See `model.ts` for the contracts. Search and breadcrumbs use IDs and parents; identical labels remain separate.
- The preview fixture in `../../demo/catalog.ts` is illustrative only; production data belongs in an authenticated adapter outside this component.
- Pass `today="YYYY-MM-DD"` for deterministic previews/tests. Otherwise the default uses Africa/Cairo.
- `value.items.mode` is explicitly `all` or `selected`. An empty `selected` list means no items, never all. Include subtrees are unioned, exclude subtrees are subtracted, and leaves are deduplicated.
- Cascading picks replace the currently edited path. “أضف مسارًا آخر” preserves that path and begins another. Selecting a lower level directly resolves its ancestors.
- Tree checkboxes operate on leaf sets; partial parents use native indeterminate checkboxes. Deselecting one child keeps its siblings. Selections compact back to complete subtrees.
- Locations have IDs; store IDs are scoped as `branchId:storeId`. Branch changes prune invalid explicitly selected stores; all-stores mode includes stores of the newly selected branches.
- `onChange` receives every draft edit. `onApply` only runs after dates, source IDs and nonempty scopes validate. Render loading/error from the adapter rather than inserting sample data on a failure.
- Local validation is for UX. The eventual API must independently validate IDs, source and permissions.
- `CatalogFilter.tsx` imports its **component-scoped stylesheet**. The preview page’s global shell, fonts and sidebar styles are separate. Brand CSS custom properties can be overridden on `.rf-filter` / `.rf-tree-dialog`.
- `Autocomplete` and `MultiSelect` in `../ui/` are separate generic controls. Import the filter stylesheet when using these controls outside `CatalogFilter`.

Pure functions in `model.ts` can be reused by adapters or tests without React. Catalog paths and descendant leaves are indexed once per input array. The tree has no network, storage, user-account or sales dependencies.
