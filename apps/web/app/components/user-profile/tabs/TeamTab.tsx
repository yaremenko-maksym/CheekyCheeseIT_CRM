import { useQuery } from '@tanstack/react-query'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/axios'

interface TeamMember {
  id: string
  displayName: string
  role: string
  avatar: string | null
}

export function TeamTab({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['user-team', userId],
    queryFn: () =>
      api
        .get<TeamMember[]>(`/teams/members?userId=${userId}`)
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 30_000,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  const members = data ?? []
  if (members.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не состоит в команде
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardContent className="space-y-2 pt-6">
        {members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 rounded border p-3">
            <Avatar className="h-9 w-9">
              {m.avatar && <AvatarImage src={m.avatar} />}
              <AvatarFallback>{m.displayName[0]}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{m.displayName}</p>
            </div>
            <Badge variant="outline">{m.role}</Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
