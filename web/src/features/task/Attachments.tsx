import type { TaskAttachment } from "@cadence/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, Trash2 } from "lucide-react";
import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { toast } from "../../components/Toaster";
import {
  attachmentUrl,
  deleteAttachment,
  deleteRecurringAttachment,
  getAttachments,
  getRecurringAttachments,
  recurringAttachmentUrl,
  uploadAttachments,
  uploadRecurringAttachments,
} from "../../lib/api";

/** Files carried by a drop or paste event ([] when it's plain text/none). */
export function eventFiles(dt: DataTransfer | null): File[] {
  return Array.from(dt?.files ?? []).filter((f) => f.size > 0);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One attachable entity (task or recurring template) — same upload/list/remove
 *  contract on both, only the endpoints and cache key differ. */
export interface AttachmentTarget {
  queryKey: readonly unknown[];
  list: () => Promise<TaskAttachment[]>;
  upload: (files: File[]) => Promise<TaskAttachment[]>;
  remove: (name: string) => Promise<TaskAttachment[]>;
  url: (name: string) => string;
}

export function taskAttachmentTarget(taskId: string): AttachmentTarget {
  return {
    queryKey: ["task", taskId, "attachments"],
    list: () => getAttachments(taskId),
    upload: (files) => uploadAttachments(taskId, files),
    remove: (name) => deleteAttachment(taskId, name),
    url: (name) => attachmentUrl(taskId, name),
  };
}

export function recurringAttachmentTarget(recurringId: string): AttachmentTarget {
  return {
    queryKey: ["recurring", recurringId, "attachments"],
    list: () => getRecurringAttachments(recurringId),
    upload: (files) => uploadRecurringAttachments(recurringId, files),
    remove: (name) => deleteRecurringAttachment(recurringId, name),
    url: (name) => recurringAttachmentUrl(recurringId, name),
  };
}

function useTargetUpload(target: AttachmentTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]) => target.upload(files),
    onSuccess: (list, files) => {
      void qc.invalidateQueries({ queryKey: target.queryKey });
      toast(
        files.length === 1
          ? `Attached ${files[0]?.name ?? "file"} — agents will see it.`
          : `Attached ${files.length} files — agents will see them.`,
      );
      return list;
    },
    onError: () => toast("Couldn’t upload — is the gateway running?"),
  });
}

/** Upload mutation shared by the section below and the context textarea's paste
 *  handler in TaskDetail (pasting a screenshot while writing a note attaches it). */
export function useAttachmentUpload(taskId: string) {
  return useTargetUpload(taskAttachmentTarget(taskId));
}

/** Same, for a recurring template (the editor's textarea paste/drop handlers). */
export function useRecurringAttachmentUpload(recurringId: string) {
  return useTargetUpload(recurringAttachmentTarget(recurringId));
}

/** The attachments block inside a task's Context section: list + attach button +
 *  drag-and-drop. Every file lands in ~/.cadence/tasks/<id>/attachments/ and is
 *  passed to agents by absolute path (images included — Claude reads them natively). */
export function AttachmentsSection({ taskId }: { taskId: string }) {
  return (
    <AttachmentsBlock
      target={taskAttachmentTarget(taskId)}
      description="Files (and screenshots) passed to Claude with this task — drop, paste, or pick."
    />
  );
}

/** Same block for a recurring template — its files are copied onto every task it creates. */
export function RecurringAttachmentsSection({ recurringId }: { recurringId: string }) {
  return (
    <AttachmentsBlock
      target={recurringAttachmentTarget(recurringId)}
      description="Files copied onto every task this template creates — drop or pick."
    />
  );
}

function AttachmentsBlock({
  target,
  description,
}: {
  target: AttachmentTarget;
  description: string;
}) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const attachments = useQuery({ queryKey: target.queryKey, queryFn: target.list });

  const upload = useTargetUpload(target);

  const remove = useMutation({
    mutationFn: (name: string) => target.remove(name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: target.queryKey }),
    onError: () => toast("Couldn’t remove the attachment."),
  });

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) upload.mutate(files);
    e.target.value = ""; // allow re-picking the same file
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = eventFiles(e.dataTransfer);
    if (files.length) upload.mutate(files);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`mt-3 rounded-md border p-3 transition-colors ${
        dragOver ? "border-primary bg-primary/5" : "border-dashed border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-medium">Attachments</h4>
          <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
        <LabeledIconButton
          icon={<Paperclip />}
          label={upload.isPending ? "Uploading…" : "Attach files"}
          variant="outline"
          size="sm"
          onClick={() => fileInput.current?.click()}
          disabled={upload.isPending}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          onChange={onPick}
          className="hidden"
          aria-label="Attach files"
        />
      </div>

      {attachments.data?.length ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {attachments.data.map((a: TaskAttachment) => (
            <li
              key={a.name}
              className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1.5 text-xs"
            >
              {a.mimeType.startsWith("image/") ? (
                <img
                  src={target.url(a.name)}
                  alt={a.name}
                  className="size-8 shrink-0 rounded object-cover"
                />
              ) : (
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <a
                href={target.url(a.name)}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate hover:underline"
                title={a.path}
              >
                {a.name}
              </a>
              <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
              <LabeledIconButton
                icon={<Trash2 />}
                label="Remove"
                variant="ghost"
                size="sm"
                onClick={() => remove.mutate(a.name)}
                disabled={remove.isPending}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {attachments.isLoading ? "Loading…" : "No attachments yet."}
        </p>
      )}
    </div>
  );
}
