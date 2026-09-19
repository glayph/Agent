import { IconSearch } from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import type { SkillSupportItem } from "@/api/skills"
import { Button } from "@/shared/ui/button"

import { OriginBadge } from "./origin-badge"
import { getOriginLabel } from "./origin-utils"
import { SkillCard } from "./skill-card"
import type { SkillGroupSection, SkillLayoutMode } from "./types"

const SKILL_LIST_PAGE_SIZE = 48

interface SkillsListProps {
  sortedSkills: SkillSupportItem[]
  groupedSkills: SkillGroupSection[]
  layoutMode: SkillLayoutMode
  sourceFilter: string
  hasActiveFilters: boolean
  onViewSkill: (skill: SkillSupportItem) => void
  onDeleteSkill: (skill: SkillSupportItem) => void
}

export function SkillsList({
  sortedSkills,
  groupedSkills,
  layoutMode,
  sourceFilter,
  hasActiveFilters,
  onViewSkill,
  onDeleteSkill,
}: SkillsListProps) {
  const { t } = useTranslation()
  const [visibleSkillCount, setVisibleSkillCount] =
    useState(SKILL_LIST_PAGE_SIZE)
  const visibleSortedSkills = useMemo(
    () => sortedSkills.slice(0, visibleSkillCount),
    [sortedSkills, visibleSkillCount],
  )
  const visibleGroupedSkills = useMemo<SkillGroupSection[]>(() => {
    let remaining = visibleSkillCount
    const sections: SkillGroupSection[] = []

    for (const section of groupedSkills) {
      if (remaining <= 0) break
      const skills = section.skills.slice(0, remaining)
      if (skills.length) {
        sections.push({ ...section, skills })
        remaining -= skills.length
      }
    }

    return sections
  }, [groupedSkills, visibleSkillCount])
  const renderedSkillCount =
    layoutMode === "grouped" && sourceFilter === "all"
      ? visibleGroupedSkills.reduce(
          (total, section) => total + section.skills.length,
          0,
        )
      : visibleSortedSkills.length
  const hiddenSkillCount = Math.max(0, sortedSkills.length - renderedSkillCount)
  const showMoreButton =
    hiddenSkillCount > 0 ? (
      <div className="flex justify-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setVisibleSkillCount((current) =>
              Math.min(sortedSkills.length, current + SKILL_LIST_PAGE_SIZE),
            )
          }
        >
          {t("common.showMore", { count: hiddenSkillCount })}
        </Button>
      </div>
    ) : null

  useEffect(() => {
    setVisibleSkillCount(SKILL_LIST_PAGE_SIZE)
  }, [layoutMode, sourceFilter, sortedSkills.length])

  if (!sortedSkills.length) {
    return (
      <div className="border-border/40 bg-muted/5 flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center shadow-sm">
        <div className="bg-muted mb-2 rounded-full p-4">
          <IconSearch className="text-muted-foreground size-6" />
        </div>
        <h3 className="text-lg font-semibold tracking-tight">
          {hasActiveFilters
            ? t("pages.agent.skills.no_results")
            : t("pages.agent.skills.empty")}
        </h3>
      </div>
    )
  }

  if (layoutMode === "grouped" && sourceFilter === "all") {
    return (
      <div className="space-y-6">
        {visibleGroupedSkills.map((section) => (
          <div key={section.origin} className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <OriginBadge
                origin={section.origin}
                label={getOriginLabel(section.origin, t)}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {section.skills.map((skill) => (
                <SkillCard
                  key={`${skill.source}:${skill.name}`}
                  skill={skill}
                  onView={() => onViewSkill(skill)}
                  onDelete={() => onDeleteSkill(skill)}
                />
              ))}
            </div>
          </div>
        ))}
        {showMoreButton}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {visibleSortedSkills.map((skill) => (
          <SkillCard
            key={`${skill.source}:${skill.name}`}
            skill={skill}
            onView={() => onViewSkill(skill)}
            onDelete={() => onDeleteSkill(skill)}
          />
        ))}
      </div>
      {showMoreButton}
    </div>
  )
}
