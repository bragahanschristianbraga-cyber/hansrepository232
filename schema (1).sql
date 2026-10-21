-- Run whole file in Supabase SQL Editor. Synthetic data only.
create table programs(id serial primary key, name text unique not null, max_gwa numeric(3,2) not null, min_units int not null,
 max_failed int not null, max_inc int not null, max_drop int not null, deadline timestamptz not null);
create table profiles(id uuid primary key default gen_random_uuid(), auth_id uuid unique references auth.users on delete set null,
 role text not null default 'scholar' check(role in('scholar','staff')), full_name text not null, student_id text unique, email text unique);
create table assignments(id serial primary key, scholar_id uuid unique not null references profiles on delete cascade, program_id int not null references programs);
create table submissions(id uuid primary key default gen_random_uuid(), scholar_id uuid not null references profiles,
 academic_year text not null check(academic_year ~ '^\d{4}-\d{4}$'), semester int not null check(semester in(1,2)),
 gwa numeric(3,2) not null check(gwa between 1 and 5), units int not null check(units>=0), failed_count int not null check(failed_count>=0),
 inc_count int not null check(inc_count>=0), dropped_count int not null check(dropped_count>=0),
 evidence_ref text not null check(length(trim(evidence_ref))>0), submitted_at timestamptz not null default now(),
 verification_status text not null default 'Pending' check(verification_status in('Pending','Verified','Returned')), verification_reason text,
 compliance_result text not null default 'Not Evaluated' check(compliance_result in('Not Evaluated','Compliant','With Deficiency')), compliance_checks jsonb,
 renewal_decision text not null default 'Pending' check(renewal_decision in('Pending','Approved','Held')), decision_note text,
 unique(scholar_id,academic_year,semester));
create table history(id bigserial primary key, submission_id uuid not null references submissions on delete cascade, actor text, action text not null, detail text, created_at timestamptz default now());

create function is_staff() returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from profiles where auth_id=auth.uid() and role='staff') $$;
create function my_pid() returns uuid language sql stable security definer set search_path=public as $$
 select id from profiles where auth_id=auth.uid() $$;
create function actor_name() returns text language sql stable security definer set search_path=public as $$
 select coalesce((select full_name||' ('||role||')' from profiles where auth_id=auth.uid()),'system') $$;

alter table programs enable row level security; alter table profiles enable row level security; alter table assignments enable row level security;
alter table submissions enable row level security; alter table history enable row level security;
create policy prog_r on programs for select to authenticated using(true);
create policy prog_w on programs for update to authenticated using(is_staff());
create policy prof_r on profiles for select to authenticated using(auth_id=auth.uid() or is_staff());
create policy prof_i on profiles for insert to authenticated with check(is_staff() and role='scholar');
create policy asg_r on assignments for select to authenticated using(scholar_id=my_pid() or is_staff());
create policy asg_w on assignments for all to authenticated using(is_staff()) with check(is_staff());
create policy sub_r on submissions for select to authenticated using(scholar_id=my_pid() or is_staff());
create policy sub_i on submissions for insert to authenticated with check(scholar_id=my_pid() and verification_status='Pending'
 and compliance_result='Not Evaluated' and renewal_decision='Pending' and submitted_at>now()-interval '1 minute');
-- no direct UPDATE/DELETE policy on submissions: all changes go through the functions below
create policy his_r on history for select to authenticated using(is_staff() or exists(select 1 from submissions s where s.id=submission_id and s.scholar_id=my_pid()));

create function log_insert() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into history(submission_id,actor,action) values(new.id,actor_name(),'Submitted'); return new; end $$;
create trigger t_log after insert on submissions for each row execute function log_insert();

create function resubmit_submission(sid uuid,g numeric,u int,f int,i int,d int,ev text) returns void language plpgsql security definer set search_path=public as $$
begin
 update submissions set gwa=g,units=u,failed_count=f,inc_count=i,dropped_count=d,evidence_ref=ev,verification_status='Pending',verification_reason=null,
  compliance_result='Not Evaluated',compliance_checks=null,renewal_decision='Pending',decision_note=null
  where id=sid and scholar_id=my_pid() and verification_status='Returned';
 if not found then raise exception 'Only your own Returned submission can be corrected'; end if;
 insert into history(submission_id,actor,action,detail) values(sid,actor_name(),'Resubmitted','Back to Pending verification');
end $$;

create function verify_submission(sid uuid,status text,reason text) returns void language plpgsql security definer set search_path=public as $$
begin
 if not is_staff() then raise exception 'Staff only'; end if;
 if status not in('Verified','Returned') then raise exception 'Invalid status'; end if;
 if status='Returned' and length(trim(coalesce(reason,'')))=0 then raise exception 'A reason is required when returning evidence'; end if;
 update submissions set verification_status=status,verification_reason=reason where id=sid and verification_status='Pending';
 if not found then raise exception 'Only Pending submissions can be verified or returned'; end if;
 insert into history(submission_id,actor,action,detail) values(sid,actor_name(),status,reason);
end $$;

create function evaluate_submission(sid uuid) returns void language plpgsql security definer set search_path=public as $$
declare s submissions; p programs; chk jsonb; res text;
begin
 if not is_staff() then raise exception 'Staff only'; end if;
 select * into s from submissions where id=sid;
 if not found then raise exception 'Submission not found'; end if;
 if s.verification_status<>'Verified' or coalesce(trim(s.evidence_ref),'')='' then raise exception 'Evidence must be Verified before evaluation'; end if;
 select pr.* into p from programs pr join assignments a on a.program_id=pr.id where a.scholar_id=s.scholar_id;
 if not found then raise exception 'Scholar has no program assigned'; end if;
 chk:=jsonb_build_array(
  jsonb_build_object('name','GWA','ok',s.gwa<=p.max_gwa,'detail','GWA '||s.gwa||' (maximum '||p.max_gwa||')'),
  jsonb_build_object('name','Units','ok',s.units>=p.min_units,'detail','Enrolled units '||s.units||' (minimum '||p.min_units||')'),
  jsonb_build_object('name','Failed','ok',s.failed_count<=p.max_failed,'detail','Failed subjects '||s.failed_count||' (allowed '||p.max_failed||')'),
  jsonb_build_object('name','Incomplete','ok',s.inc_count<=p.max_inc,'detail','Incomplete grades '||s.inc_count||' (allowed '||p.max_inc||')'),
  jsonb_build_object('name','Dropped','ok',s.dropped_count<=p.max_drop,'detail','Dropped subjects '||s.dropped_count||' (allowed '||p.max_drop||')'),
  jsonb_build_object('name','Deadline','ok',s.submitted_at<=p.deadline,'detail','Submitted '||to_char(s.submitted_at at time zone 'Asia/Manila','YYYY-MM-DD HH24:MI')||' (deadline '||to_char(p.deadline at time zone 'Asia/Manila','YYYY-MM-DD HH24:MI')||' Manila)'));
 res:=case when exists(select 1 from jsonb_array_elements(chk) e where (e->>'ok')::boolean=false) then 'With Deficiency' else 'Compliant' end;
 update submissions set compliance_checks=chk,compliance_result=res,renewal_decision='Pending',decision_note=null where id=sid;
 insert into history(submission_id,actor,action,detail) values(sid,actor_name(),'Evaluated',res);
end $$;

create function decide_renewal(sid uuid,decision text,note text) returns void language plpgsql security definer set search_path=public as $$
declare s submissions;
begin
 if not is_staff() then raise exception 'Staff only'; end if;
 if decision not in('Approved','Held') then raise exception 'Invalid decision'; end if;
 select * into s from submissions where id=sid;
 if s.verification_status<>'Verified' or s.compliance_result='Not Evaluated' then raise exception 'Record must be verified and evaluated first'; end if;
 if decision='Approved' and s.compliance_result<>'Compliant' then raise exception 'Cannot approve a record with deficiency'; end if;
 update submissions set renewal_decision=decision,decision_note=note where id=sid;
 insert into history(submission_id,actor,action,detail) values(sid,actor_name(),'Renewal '||decision,note);
end $$;

-- Link a login to a pre-registered profile (same email), else create a scholar profile
create function handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
 update profiles set auth_id=new.id where lower(email)=lower(new.email) and auth_id is null;
 if not found then insert into profiles(auth_id,full_name,email) values(new.id,split_part(new.email,'@',1),lower(new.email)); end if;
 return new;
end $$;
create trigger on_auth_user after insert on auth.users for each row execute function handle_new_user();

-- Policies and seed (fictional)
insert into programs(name,max_gwa,min_units,max_failed,max_inc,max_drop,deadline) values
 ('Excellence Scholar',2.00,18,0,0,0,'2026-11-06 17:00+08'),('Access Scholar',2.50,15,0,0,1,'2026-11-06 17:00+08');
insert into profiles(full_name,student_id,email) select 'Scholar '||n,'2026-'||n,lower(n)||'@example.test' from unnest(array['B01','B02','B03','B04','B05','B06']) n;
insert into assignments(scholar_id,program_id) select p.id,(select id from programs where name=case when p.student_id in('2026-B01','2026-B02','2026-B05') then 'Excellence Scholar' else 'Access Scholar' end) from profiles p where student_id like '2026-B%';
insert into submissions(scholar_id,academic_year,semester,gwa,units,failed_count,inc_count,dropped_count,evidence_ref,submitted_at,verification_status)
select p.id,'2026-2027',1,v.g,v.u,v.f,v.i,v.d,'GD-'||v.c,v.t,v.s from (values
 ('B01',2.00,18,0,0,0,'2026-11-06 17:00+08'::timestamptz,'Verified'),('B02',2.01,18,0,0,0,'2026-11-05 17:00+08','Verified'),
 ('B03',2.50,15,0,0,1,'2026-11-05 17:00+08','Verified'),('B04',2.50,14,0,1,0,'2026-11-05 17:00+08','Verified'),
 ('B05',1.75,18,1,0,0,'2026-11-06 17:01+08','Verified'),('B06',2.25,15,0,0,0,'2026-11-05 17:00+08','Pending')) v(c,g,u,f,i,d,t,s)
join profiles p on p.student_id='2026-'||v.c;
-- After creating your staff login: update profiles set role='staff' where email='YOUR_STAFF_EMAIL';
