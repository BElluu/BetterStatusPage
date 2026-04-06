import type { TranslationKey } from '@bsp/shared'

export const EN_DEFAULTS: Record<TranslationKey, string> = {
  'status.operational':    'Operational',
  'status.outage':         'Outage',
  'status.partialOutage':  'Partial Outage',
  'status.degraded':       'Degraded',
  'status.checking':       'Checking',
  'status.pending':        'Checking',

  'overall.allOperational':      'All systems operational.',
  'overall.majorOutage':         'Major Outage.',
  'overall.partialOutage':       'Partial Outage.',
  'overall.partialDegradation':  'Partial Degradation.',
  'overall.incidentsInProgress': 'Incidents in Progress.',
  'overall.checking':            'Checking\u2026',

  'page.hero':              'Real-time Network Status',
  'page.monitoredLine':     '{n} services monitored in real time.',
  'page.incidentLine':      '{n} active incidents.',
  'page.groupServiceCount': '{n} services',

  'section.systemEvents': 'System Events',
  'tab.active':           'Active',
  'tab.history':          'History',

  'empty.noActiveIncidents': 'No active incidents \u2014 all systems running normally.',
  'empty.noHistory':         'No incident history to display.',
  'empty.noIncidents':       'No incidents to display.',

  'uptime.daysAgo':    '{n} days ago',
  'uptime.today':      'Today',
  'uptime.noData':     'No data',
  'uptime.pct':        'Uptime: {pct}%',
  'uptime.resolvedIn': 'Resolved in {duration}',
  'uptime.ongoing':    'Ongoing',
  'uptime.affected':   'Affected',
  'uptime.noIncidents':'No incidents',

  'incident.investigating': 'Investigating',
  'incident.identified':    'Identified',
  'incident.monitoring':    'Monitoring',
  'incident.resolved':      'Resolved',
}
