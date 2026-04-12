import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DatabaseZap } from 'lucide-react'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { deriveConnectionStatus } from '@/components/ui/source-status-indicator'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { sourceSelection } from '@/hooks/useEntitySelection'
import { SourceMenu } from './SourceMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { EditPopover, getEditConfig, type EditContextKey } from '@/components/ui/EditPopover'
import type { LoadedSource, SourceConnectionStatus, SourceFilter } from '../../../shared/types'
import { getSourceSidebarCategory } from '@/lib/source-plugins'
import { routes, navigate } from '@/lib/navigate'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

const SOURCE_TYPE_CONFIG: Record<string, { labelKey: string; colorClass: string }> = {
  mcp: { labelKey: 'sourcesList.typeMcp', colorClass: 'bg-accent/10 text-accent' },
  api: { labelKey: 'sourcesList.typeApi', colorClass: 'bg-success/10 text-success' },
  local: { labelKey: 'sourcesList.typeLocal', colorClass: 'bg-info/10 text-info' },
  cli: { labelKey: 'sourcesList.typeCli', colorClass: 'bg-warning/10 text-warning' },
  plugin: { labelKey: 'sourcesList.typePlugin', colorClass: 'bg-foreground/10 text-foreground' },
}

const SOURCE_STATUS_CONFIG: Record<string, { labelKey: string; colorClass: string } | null> = {
  connected: null,
  needs_auth: { labelKey: 'sourcesList.statusAuthRequired', colorClass: 'bg-warning/10 text-warning' },
  failed: { labelKey: 'sourcesList.statusDisconnected', colorClass: 'bg-destructive/10 text-destructive' },
  untested: { labelKey: 'sourcesList.statusNotTested', colorClass: 'bg-foreground/10 text-foreground/50' },
  local_disabled: { labelKey: 'sourcesList.statusDisabled', colorClass: 'bg-foreground/10 text-foreground/50' },
}

const SOURCE_TYPE_FILTER_LABEL_KEYS: Record<string, string> = {
  api: 'sourcesList.filterApi',
  mcp: 'sourcesList.filterMcp',
  local: 'sourcesList.filterLocalFolder',
  cli: 'sourcesList.filterCli',
  plugin: 'sourcesList.filterPlugin',
}

export interface SourcesListPanelProps {
  sources: LoadedSource[]
  sourceFilter?: SourceFilter | null
  workspaceRootPath?: string
  onDeleteSource: (sourceSlug: string) => void
  onSourceClick: (source: LoadedSource) => void
  selectedSourceSlug?: string | null
  localMcpEnabled?: boolean
  className?: string
}

export function SourcesListPanel({
  sources,
  sourceFilter,
  workspaceRootPath,
  onDeleteSource,
  onSourceClick,
  selectedSourceSlug,
  localMcpEnabled = true,
  className,
}: SourcesListPanelProps) {
  const { t } = useTranslation()
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1
  const [expandedPluginSlug, setExpandedPluginSlug] = React.useState<string | null>(null)

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  const filteredSources = React.useMemo(() => {
    if (!sourceFilter) return sources
    return sources.filter((source) => getSourceSidebarCategory(source) === sourceFilter.sourceType)
  }, [sources, sourceFilter])

  const emptyMessage = React.useMemo(() => {
    if (sourceFilter?.kind === 'type') {
      const filterLabelKey = SOURCE_TYPE_FILTER_LABEL_KEYS[sourceFilter.sourceType]
      const filterLabel = filterLabelKey ? t(filterLabelKey) : sourceFilter.sourceType
      return t('sourcesList.noSourcesOfType', { type: filterLabel })
    }
    return t('sourcesList.noSourcesConfigured')
  }, [sourceFilter, t])

  React.useEffect(() => {
    if (!selectedSourceSlug) {
      setExpandedPluginSlug(null)
      return
    }
    const selected = filteredSources.find((source) => source.config.slug === selectedSourceSlug)
    if (selected && getSourceSidebarCategory(selected) === 'plugin') {
      setExpandedPluginSlug(selectedSourceSlug)
    }
  }, [filteredSources, selectedSourceSlug])

  const handleSourceItemClick = React.useCallback((source: LoadedSource) => {
    if (getSourceSidebarCategory(source) === 'plugin') {
      setExpandedPluginSlug((prev) => prev === source.config.slug ? null : source.config.slug)
    } else {
      setExpandedPluginSlug(null)
    }
    onSourceClick(source)
  }, [onSourceClick])

  return (
    <>
    <EntityPanel<LoadedSource>
      items={filteredSources}
      getId={(s) => s.config.slug}
      selection={sourceSelection}
      selectedId={selectedSourceSlug}
      onItemClick={handleSourceItemClick}
      className={className}
      emptyState={
        <EntityListEmptyScreen
          icon={<DatabaseZap />}
          title={emptyMessage}
          description={t('sourcesList.emptyDescription')}
          docKey="sources"
        >
          {workspaceRootPath && (
            <EditPopover
              align="center"
              trigger={
                <button className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                  {t('sourcesList.addSource')}
                </button>
              }
              {...getEditConfig(
                sourceFilter?.kind === 'type' && (sourceFilter.sourceType === 'api' || sourceFilter.sourceType === 'mcp' || sourceFilter.sourceType === 'local')
                  ? `add-source-${sourceFilter.sourceType}` as EditContextKey
                  : 'add-source',
                workspaceRootPath
              )}
            />
          )}
        </EntityListEmptyScreen>
      }
      mapItem={(source) => {
        const connectionStatus = deriveConnectionStatus(source, localMcpEnabled)
        const typeConfig = SOURCE_TYPE_CONFIG[getSourceSidebarCategory(source)]
        const statusConfig = SOURCE_STATUS_CONFIG[connectionStatus]
        const subtitle = source.config.tagline || source.config.provider || ''
        const pluginItems = source.config.plugin?.items ?? []
        const showPluginChildren =
          getSourceSidebarCategory(source) === 'plugin' &&
          expandedPluginSlug === source.config.slug &&
          pluginItems.length > 1

        return {
          icon: <SourceAvatar source={source} size="sm" />,
          title: source.config.name,
          badges: (
            <>
              {typeConfig && <EntityListBadge colorClass={typeConfig.colorClass}>{t(typeConfig.labelKey)}</EntityListBadge>}
              {statusConfig && (
                <EntityListBadge colorClass={statusConfig.colorClass} tooltip={source.config.connectionError || undefined} className="cursor-default">
                  {t(statusConfig.labelKey)}
                </EntityListBadge>
              )}
              {subtitle && <span className="truncate">{subtitle}</span>}
            </>
          ),
          menu: (
            <SourceMenu
              sourceSlug={source.config.slug}
              sourceName={source.config.name}
              onOpenInNewWindow={() => window.electronAPI.openUrl(`craftagents://sources/source/${source.config.slug}?window=focused`)}
              onShowInFinder={() => window.electronAPI.showInFolder(source.folderPath)}
              onDelete={() => onDeleteSource(source.config.slug)}
              onSendToWorkspace={hasOtherWorkspaces ? () => {
                setSendResourceSlug(source.config.slug)
                setSendResourceLabel(source.config.name)
                setSendDialogOpen(true)
              } : undefined}
            />
          ),
          children: showPluginChildren ? (
            <div className="ml-8 mr-4 mb-3 rounded-[8px] border border-border/40 overflow-hidden bg-background/60">
              {pluginItems.map((item, index) => (
                <button
                  key={`${source.config.slug}:${item.id}`}
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(routes.view.sources({ sourceSlug: source.config.slug, skillSlug: item.skill, type: 'plugin' }))
                  }}
                  className={cn(
                    'w-full px-3 py-2.5 text-left hover:bg-foreground/[0.03] transition-colors',
                    index > 0 && 'border-t border-border/30'
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="shrink-0 pt-0.5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-foreground/6 text-muted-foreground">
                        <Sparkles className="h-3.5 w-3.5" />
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {item.label || item.skill}
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-2">
                        {item.description || item.skill}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : undefined,
        }
      }}
    />

    {/* Send to Workspace dialog */}
    {sendResourceSlug && (
      <SendResourceToWorkspaceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        resourceType="source"
        resourceIds={[sendResourceSlug]}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
    )}
    </>
  )
}
