import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createCourse, listCourses } from "@/lib/attendance.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { BookOpen, Plus, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function Dashboard() {
  const list = useServerFn(listCourses);
  const create = useServerFn(createCourse);
  const qc = useQueryClient();
  const [name, setName] = useState("");

  const { data: courses = [], isLoading } = useQuery({
    queryKey: ["courses"],
    queryFn: () => list({}) as Promise<Array<{ id: string; name: string; created_at: string }>>,
  });

  const mut = useMutation({
    mutationFn: (n: string) => create({ data: { name: n } }),
    onSuccess: () => {
      toast.success("Course added");
      setName("");
      qc.invalidateQueries({ queryKey: ["courses"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    mut.mutate(n);
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Your courses</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Add a course, then generate a 1-minute QR for students to scan.
        </p>
      </section>

      <Card className="p-4">
        <form onSubmit={submit} className="flex gap-2">
          <Input
            placeholder="Add a new course (e.g. Anatomy 101)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={mut.isPending}
          />
          <Button type="submit" disabled={mut.isPending || !name.trim()}>
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </form>
      </Card>

      <section className="space-y-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : courses.length === 0 ? (
          <Card className="p-10 text-center text-muted-foreground">
            <BookOpen className="h-8 w-8 mx-auto mb-3 opacity-40" />
            No courses yet. Add your first one above.
          </Card>
        ) : (
          courses.map((c) => (
            <Link
              key={c.id}
              to="/courses/$id"
              params={{ id: c.id }}
              className="block"
            >
              <Card className="p-4 flex items-center justify-between hover:bg-accent transition-colors">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary grid place-items-center">
                    <BookOpen className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Added {new Date(c.created_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </Card>
            </Link>
          ))
        )}
      </section>
    </div>
  );
}
