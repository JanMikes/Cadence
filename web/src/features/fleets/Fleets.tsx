import type { Fleet } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { createFleet, getFleets, getProjects, updateFleet } from "../../lib/api";

/**
 * Fleets (spec §4): named, ordered sets of projects for multi-repo tasks. Create
 * a fleet and pick its member projects; a fleet task fans execution across them.
 */
export function Fleets() {
  const qc = useQueryClient();
  const fleets = useQuery({ queryKey: ["fleets"], queryFn: getFleets });
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });

  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () => createFleet({ name: name.trim(), projects: members }),
    onSuccess: () => {
      setName("");
      setMembers([]);
      void qc.invalidateQueries({ queryKey: ["fleets"] });
    },
  });

  const toggle = (slug: string) =>
    setMembers((m) => (m.includes(slug) ? m.filter((s) => s !== slug) : [...m, slug]));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !create.isPending) create.mutate();
  };

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <Boxes className="size-5" /> Fleets
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        A fleet groups projects for multi-repo tasks — execution runs across each member’s repo.
      </p>

      <section className="mt-6 rounded-lg border border-border bg-card/40 p-4">
        <h2 className="text-sm font-medium">New fleet</h2>
        <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Fleet name"
            aria-label="Fleet name"
            className="rounded-md border border-border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Member projects</span>
            {projects.data?.length ? (
              <div className="flex flex-wrap gap-2">
                {projects.data.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p.slug)}
                    className={`rounded-md border px-2.5 py-1 text-xs ${
                      members.includes(p.slug)
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">No projects yet — create some first.</span>
            )}
          </div>
          <div className="flex justify-end">
            <LabeledIconButton
              icon={<Plus />}
              label="Create fleet"
              type="submit"
              disabled={!name.trim() || create.isPending}
            />
          </div>
        </form>
      </section>

      <ul className="mt-6 flex flex-col gap-2">
        {fleets.data?.length === 0 ? (
          <li className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No fleets yet — create your first above.
          </li>
        ) : null}
        {fleets.data?.map((f) => (
          <FleetRow key={f.id} fleet={f} />
        ))}
      </ul>
    </div>
  );
}

function FleetRow({ fleet }: { fleet: Fleet }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const setMembers = useMutation({
    mutationFn: (projectSlugs: string[]) => updateFleet(fleet.slug, { projects: projectSlugs }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["fleets"] }),
  });
  const toggle = (slug: string) => {
    const next = fleet.projects.includes(slug)
      ? fleet.projects.filter((s) => s !== slug)
      : [...fleet.projects, slug];
    setMembers.mutate(next);
  };

  return (
    <li className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{fleet.name}</span>
        <span className="text-xs text-muted-foreground">{fleet.projects.length} projects</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {projects.data?.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => toggle(p.slug)}
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              fleet.projects.includes(p.slug)
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>
    </li>
  );
}
