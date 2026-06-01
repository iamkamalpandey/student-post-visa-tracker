-- ============================================================================
-- commission_claims.enrollment_id: change ON DELETE CASCADE -> RESTRICT.
--
-- A commission claim is a financial accounting record. Cascading the delete of
-- an enrollment would silently wipe revenue history if a future maintenance
-- script or admin tool ever hard-deletes an enrollment. Enrollments are
-- soft-deleted via deleted_at in normal operation; the claim persists.
--
-- RESTRICT means a hard-delete attempt on the parent enrollment fails loudly
-- with a Postgres constraint violation — operators can investigate before the
-- accounting record is lost.
-- ============================================================================

ALTER TABLE commission_claims
  DROP CONSTRAINT IF EXISTS commission_claims_enrollment_id_fkey;

ALTER TABLE commission_claims
  ADD CONSTRAINT commission_claims_enrollment_id_fkey
  FOREIGN KEY (enrollment_id) REFERENCES enrollments (id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
