import { Card, CardBody, CardHeader } from '@/components/ui/card'

import { formatRelative, type BackgroundTask } from './types'

type Props = {
  tasks: BackgroundTask[]
}

export function BackgroundTasksPanel({ tasks }: Props) {
  return (
    <Card>
      <CardHeader>
        <h2>Background Tasks</h2>
      </CardHeader>
      <CardBody>
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Runs</th>
              <th>Errors</th>
              <th>Last status</th>
              <th>Last duration</th>
              <th>Last finished</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.name}>
                <td className="mono">{task.name}</td>
                <td>{task.run_count}</td>
                <td className={task.error_count ? 'admin-observability__danger-text' : undefined}>
                  {task.error_count}
                </td>
                <td
                  className={
                    task.last_status === 'error' ? 'admin-observability__danger-text' : undefined
                  }
                >
                  {task.last_status ?? '—'}
                </td>
                <td>
                  {task.last_duration_ms != null ? `${task.last_duration_ms.toFixed(0)}ms` : '—'}
                </td>
                <td>{formatRelative(task.last_finished_at)}</td>
                <td
                  className="muted admin-observability__truncate-cell"
                  title={task.last_error ?? undefined}
                >
                  {task.last_error ?? '—'}
                </td>
              </tr>
            ))}
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No background tasks recorded yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CardBody>
    </Card>
  )
}
