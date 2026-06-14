import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const SESSION_DURATION_SEC = 60;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- DOCTOR (authenticated) ----------

export const listCourses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("courses")
      .select("id, name, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createCourse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ name: z.string().trim().min(1).max(120) }).parse(d))
  .handler(async ({ data, context }) => {
    // dedup case-insensitive per doctor
    const { data: existing } = await context.supabase
      .from("courses")
      .select("id")
      .eq("doctor_id", context.userId)
      .ilike("name", data.name)
      .maybeSingle();
    if (existing) throw new Error("A course with this name already exists.");

    const { data: row, error } = await context.supabase
      .from("courses")
      .insert({ name: data.name, doctor_id: context.userId })
      .select("id, name, created_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const getCourse = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("courses")
      .select("id, name, created_at")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Course not found");
    return row;
  });

export const createAttendanceSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        courseId: z.string().uuid(),
        sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusM: z.number().int().min(10).max(5000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SEC * 1000).toISOString();
    const { data: row, error } = await context.supabase
      .from("attendance_sessions")
      .insert({
        course_id: data.courseId,
        doctor_id: context.userId,
        session_date: data.sessionDate,
        target_lat: data.lat,
        target_lng: data.lng,
        radius_m: data.radiusM,
        expires_at: expiresAt,
      })
      .select("id, token, expires_at, session_date")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const listRecords = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ sessionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("attendance_records")
      .select("id, student_name, student_id, ip_address, lat, lng, created_at")
      .eq("session_id", data.sessionId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// ---------- STUDENT (public) ----------

export const getPublicSession = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("attendance_sessions")
      .select(
        "id, course_id, session_date, target_lat, target_lng, radius_m, expires_at, courses(name)",
      )
      .eq("token", data.token)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return { found: false as const };
    const expired = new Date(row.expires_at).getTime() < Date.now();
    return {
      found: true as const,
      expired,
      sessionId: row.id,
      courseId: row.course_id,
      sessionDate: row.session_date,
      targetLat: row.target_lat,
      targetLng: row.target_lng,
      radiusM: row.radius_m,
      expiresAt: row.expires_at,
      // @ts-expect-error joined relation
      courseName: row.courses?.name ?? "Course",
    };
  });

export const submitAttendance = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        studentName: z.string().trim().min(1).max(120),
        studentId: z.string().trim().min(1).max(60),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const ip = getRequestIP({ xForwardedFor: true }) ?? "unknown";
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: session, error: sErr } = await supabaseAdmin
      .from("attendance_sessions")
      .select(
        "id, course_id, doctor_id, session_date, target_lat, target_lng, radius_m, expires_at",
      )
      .eq("token", data.token)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!session) throw new Error("Invalid attendance link.");
    if (new Date(session.expires_at).getTime() < Date.now())
      throw new Error("This QR code has expired. Please ask the doctor to generate a new one.");

    const distance = haversineMeters(
      data.lat,
      data.lng,
      session.target_lat,
      session.target_lng,
    );
    if (distance > session.radius_m)
      throw new Error(
        `You are too far from the classroom (${Math.round(distance)}m away, must be within ${session.radius_m}m).`,
      );

    const { error: insErr } = await supabaseAdmin.from("attendance_records").insert({
      session_id: session.id,
      course_id: session.course_id,
      doctor_id: session.doctor_id,
      session_date: session.session_date,
      student_name: data.studentName,
      student_id: data.studentId,
      ip_address: ip,
      lat: data.lat,
      lng: data.lng,
    });

    if (insErr) {
      const msg = insErr.message.toLowerCase();
      if (msg.includes("uniq_per_ip"))
        throw new Error("This device has already submitted attendance for today.");
      if (msg.includes("uniq_per_student"))
        throw new Error("This Student ID has already been used for today.");
      throw new Error(insErr.message);
    }

    return { ok: true as const };
  });
