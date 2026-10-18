-- Respaldo completo de notification_db (notification-service): esquema + datos de ejemplo (database/seed.sql).
-- Generado con pg_dump --no-owner --no-privileges. Restaurar en una base vacía:
--   psql "$DATABASE_URL" -f database/backup.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id character varying NOT NULL,
    staff_username character varying NOT NULL,
    action character varying NOT NULL,
    target_type character varying NOT NULL,
    target_id character varying NOT NULL,
    reason character varying(300),
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    staff_role character varying
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    event character varying NOT NULL,
    channel character varying NOT NULL,
    title character varying NOT NULL,
    body text NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    read boolean DEFAULT false NOT NULL,
    metadata jsonb,
    dedupe_key character varying NOT NULL,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    last_error character varying(500),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: otp_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_challenges (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user uuid NOT NULL,
    purpose character varying DEFAULT 'registration'::character varying NOT NULL,
    phone character varying(16) NOT NULL,
    code_hash character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_sent_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: user_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_contacts (
    id_user uuid NOT NULL,
    email character varying,
    nombre_completo character varying,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Data for Name: admin_audit; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.admin_audit (id, staff_id, staff_username, action, target_type, target_id, reason, details, created_at, staff_role) FROM stdin;
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notifications (id, id_user, event, channel, title, body, status, read, metadata, dedupe_key, delivery_attempts, next_attempt_at, last_error, created_at, updated_at) FROM stdin;
42000000-0000-4000-8000-000000000001	22222222-2222-4222-8222-222222222222	transaction.completed	in_app	Recibiste $150.000	Ana Pérez te envió $150.000: Arriendo compartido.	sent	f	\N	22222222-2222-4222-8222-222222222222:transaction.completed:in_app:2026-10-02T15:00:00.000Z	0	\N	\N	2026-10-02 10:00:00	2026-10-18 06:23:44.278735
42000000-0000-4000-8000-000000000002	11111111-1111-4111-8111-111111111111	transaction.completed	in_app	Pagaste tu factura	Pagaste $85.000 a Acueducto de Bogotá.	sent	t	\N	11111111-1111-4111-8111-111111111111:transaction.completed:in_app:2026-10-04T15:00:00.000Z	0	\N	\N	2026-10-04 10:00:00	2026-10-18 06:23:44.278735
\.


--
-- Data for Name: otp_challenges; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.otp_challenges (id, id_user, purpose, phone, code_hash, expires_at, last_sent_at, attempts, verified, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: user_contacts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_contacts (id_user, email, nombre_completo, updated_at) FROM stdin;
11111111-1111-4111-8111-111111111111	ana.perez@banklite.test	Ana Pérez	2026-10-01 09:01:00
22222222-2222-4222-8222-222222222222	carlos.gomez@banklite.test	Carlos Gómez	2026-10-01 09:06:00
\.


--
-- Name: user_contacts PK_0853d398636428c28c071538f14; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_contacts
    ADD CONSTRAINT "PK_0853d398636428c28c071538f14" PRIMARY KEY (id_user);


--
-- Name: admin_audit PK_5ad48a4d9d16397ef37e28bb0be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT "PK_5ad48a4d9d16397ef37e28bb0be" PRIMARY KEY (id);


--
-- Name: notifications PK_6a72c3c0f683f6462415e653c3a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY (id);


--
-- Name: otp_challenges PK_c34f21df6c8aa51229715452068; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_challenges
    ADD CONSTRAINT "PK_c34f21df6c8aa51229715452068" PRIMARY KEY (id);


--
-- Name: notifications UQ_1ce34a3c9fd97cd56bcb734ca9e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT "UQ_1ce34a3c9fd97cd56bcb734ca9e" UNIQUE (dedupe_key);


--
-- Name: IDX_0e806c45aba0b985389b588cd3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_0e806c45aba0b985389b588cd3" ON public.notifications USING btree (next_attempt_at);


--
-- Name: IDX_1ce34a3c9fd97cd56bcb734ca9; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_1ce34a3c9fd97cd56bcb734ca9" ON public.notifications USING btree (dedupe_key);


--
-- Name: IDX_8decd83b4b9593f5219e5f3085; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8decd83b4b9593f5219e5f3085" ON public.admin_audit USING btree (target_id);


--
-- Name: IDX_b43141fd087120f5aa298457d3; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_b43141fd087120f5aa298457d3" ON public.otp_challenges USING btree (id_user, purpose);


--
-- Name: IDX_cb298b4b34de779c74815e66e6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cb298b4b34de779c74815e66e6" ON public.notifications USING btree (id_user);


--
-- Name: idx_admin_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_created ON public.admin_audit USING btree (created_at);


--
-- PostgreSQL database dump complete
--


