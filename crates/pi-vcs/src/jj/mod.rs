//! Jujutsu backend: jj-lib-powered workspace operations. No subprocess at all.
//!
//! Workspace discovery is a pure filesystem walk (`.jj/repo` presence,
//! including the file indirection non-default workspaces use), cheap enough
//! for synchronous render paths. jj-lib loading happens lazily inside
//! operations.

mod ops;

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// An opened Jujutsu workspace.
#[derive(Debug)]
pub struct JjWorkspace {
	root:     PathBuf,
	repo_dir: PathBuf,
}

impl JjWorkspace {
	/// Discover the workspace containing `dir` by walking toward the root.
	/// Returns `Ok(None)` when `dir` is not inside a Jujutsu workspace.
	pub fn discover(dir: &Path) -> Result<Option<Self>> {
		Ok(crate::discover_jj(dir)?.map(|(root, repo_dir)| Self { root, repo_dir }))
	}

	/// Like [`JjWorkspace::discover`], but errors with [`Error::NotARepository`]
	/// when `dir` is outside any workspace.
	pub fn require(dir: &Path) -> Result<Self> {
		Self::discover(dir)?.ok_or_else(|| Error::NotARepository { path: dir.to_owned() })
	}

	/// Workspace root: the directory containing `.jj`.
	pub fn root(&self) -> &Path {
		&self.root
	}

	/// Default workspace root shared by every workspace in this repository.
	pub fn primary_root(&self) -> PathBuf {
		self
			.repo_dir
			.parent()
			.and_then(Path::parent)
			.map_or_else(|| self.root.clone(), Path::to_owned)
	}

	/// Shared repo directory backing this workspace, resolved through the
	/// `.jj/repo` file indirection used by non-default workspaces.
	pub fn repo_dir(&self) -> &Path {
		&self.repo_dir
	}

	/// Path of the shared workspace store directory.
	pub fn store_dir(&self) -> PathBuf {
		self.repo_dir.join("store")
	}

	/// Directory whose entries change whenever the repository operation head
	/// moves.
	pub fn watch_target(&self) -> PathBuf {
		self.repo_dir.join("op_heads").join("heads")
	}
}
