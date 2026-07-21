import { IconLoader2, IconPlus } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"

import { DeleteDialog } from "./delete-dialog"
import { DetailSheet } from "./detail-sheet"
import { FilterBar } from "./filter-bar"
import { ImportDialog } from "./import-dialog"
import { PageSkeleton } from "./page-skeleton"
import { PluginReadinessPanel } from "./plugin-readiness-panel"
import { SkillsList } from "./skills-list"
import { Stats } from "./stats"
import { useSkillsPage } from "./use-skills-page"

export function SkillsPage() {
  const { t } = useTranslation()
  const {
    searchQuery,
    sourceFilter,
    sortOrder,
    layoutMode,
    detailView,
    isDragActive,
    isImportDialogOpen,
    selectedSkill,
    skillPendingDelete,
    availableOrigins,
    groupedSkills,
    stats,
    statusMessage,
    sortedSkills,
    hasActiveFilters,
    importInputRef,
    selectedSkillDetail,
    pluginReadiness,
    skillsError,
    skillDetailError,
    pluginReadinessError,
    isLoading,
    isPluginReadinessLoading,
    isSkillDetailLoading,
    isImportPending,
    isDeletePending,
    setSearchQuery,
    setSourceFilter,
    setSortOrder,
    setLayoutMode,
    setDetailView,
    openImportDialog,
    handleViewSkill,
    handleRequestDelete,
    handleConfirmDelete,
    handleImportClick,
    handleImportFileChange,
    handleDropZoneDragEnter,
    handleDropZoneDragLeave,
    handleDropZoneDrop,
    handleDetailSheetOpenChange,
    handleImportDialogOpenChange,
    handleDeleteDialogOpenChange,
  } = useSkillsPage()

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("navigation.skills")}
        children={
          <>
            <input
              ref={importInputRef}
              type="file"
              aria-label={t("pages.agent.skills.import")}
              accept=".md,text/markdown,text/plain"
              className="hidden"
              onChange={handleImportFileChange}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={openImportDialog}
              disabled={isImportPending}
              className="max-sm:size-8 max-sm:gap-0 max-sm:rounded-full max-sm:px-0"
              aria-label={t("pages.agent.skills.import")}
              title={t("pages.agent.skills.import")}
            >
              {isImportPending ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconPlus className="size-4" />
              )}
              <span className="max-sm:hidden">
                {t("pages.agent.skills.import")}
              </span>
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="w-full max-w-6xl space-y-8">
          {statusMessage && (
            <div
              className={
                statusMessage.kind === "error"
                  ? "border-border bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm"
                  : "border-border bg-muted/60 text-foreground rounded-lg border px-3 py-2 text-sm"
              }
              role={statusMessage.kind === "error" ? "alert" : "status"}
              aria-live={
                statusMessage.kind === "error" ? "assertive" : "polite"
              }
            >
              {statusMessage.text}
            </div>
          )}
          {isLoading ? (
            <PageSkeleton />
          ) : skillsError ? (
            <div className="text-destructive py-6 text-sm">
              {t("pages.agent.load_error")}
            </div>
          ) : (
            <section className="animate-in fade-in space-y-3 duration-300 md:duration-500">
              <Stats stats={stats} />
              <PluginReadinessPanel
                readiness={pluginReadiness}
                isLoading={isPluginReadinessLoading}
                error={pluginReadinessError}
              />

              <div className="flex flex-col gap-4 py-3">
                <FilterBar
                  searchQuery={searchQuery}
                  sourceFilter={sourceFilter}
                  availableOrigins={availableOrigins}
                  sortOrder={sortOrder}
                  layoutMode={layoutMode}
                  onSearchQueryChange={setSearchQuery}
                  onSourceFilterChange={setSourceFilter}
                  onSortOrderChange={setSortOrder}
                  onLayoutModeChange={setLayoutMode}
                />
              </div>

              <SkillsList
                sortedSkills={sortedSkills}
                groupedSkills={groupedSkills}
                layoutMode={layoutMode}
                sourceFilter={sourceFilter}
                hasActiveFilters={hasActiveFilters}
                onViewSkill={handleViewSkill}
                onDeleteSkill={handleRequestDelete}
              />
            </section>
          )}
        </div>
      </div>

      <DetailSheet
        open={selectedSkill !== null}
        selectedSkill={selectedSkill}
        selectedSkillDetail={selectedSkillDetail}
        isLoading={isSkillDetailLoading}
        error={skillDetailError}
        detailView={detailView}
        onDetailViewChange={setDetailView}
        onOpenChange={handleDetailSheetOpenChange}
      />

      <ImportDialog
        open={isImportDialogOpen}
        isImportPending={isImportPending}
        isDragActive={isDragActive}
        onOpenChange={handleImportDialogOpenChange}
        onImportClick={handleImportClick}
        onDragEnter={handleDropZoneDragEnter}
        onDragLeave={handleDropZoneDragLeave}
        onDrop={handleDropZoneDrop}
      />

      <DeleteDialog
        open={skillPendingDelete !== null}
        skillPendingDelete={skillPendingDelete}
        isDeletePending={isDeletePending}
        onOpenChange={handleDeleteDialogOpenChange}
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
