import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Table } from '@/components/ui/table'
import { MoveClassification } from '@/components/analysis/move-classification'
import { useAppStore } from '@/store/app-store'

type DeviationRow = {
  fen: string
  userMove: string
  bestMove: string
  cpLoss: number
}

export function DeviationList({ rows }: { rows: DeviationRow[] }) {
  const pushPosition = useAppStore((state) => state.pushPosition)

  return (
    <Card>
      <CardHeader>
        <h2>Deviation List</h2>
      </CardHeader>
      <CardBody>
        <Table>
          <thead>
            <tr>
              <th>Your move</th>
              <th>Best move</th>
              <th>Loss</th>
              <th>Class</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td className="muted" colSpan={4}>Deviation results will appear here.</td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={`${row.fen}-${row.userMove}`}>
                <td>
                  <button className="button button--ghost" onClick={() => pushPosition(row.fen)} type="button">
                    {row.userMove}
                  </button>
                </td>
                <td>{row.bestMove}</td>
                <td>{row.cpLoss}</td>
                <td><MoveClassification cpLoss={row.cpLoss} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  )
}
